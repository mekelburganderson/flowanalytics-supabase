import { createClient } from "npm:@supabase/supabase-js@2.57.0";

/**
 * Flow Analytics | Reconciliação incremental de Issues do grupo GitLab 320.
 *
 * POST {} (sem parâmetros):
 * - busca Issues abertas/fechadas atualizadas desde 2026-01-01 na primeira execução;
 * - inclui Issues criadas antes de 2026 e alteradas/fechadas a partir dessa data;
 * - em execuções posteriores, usa checkpoint com sobreposição de 10 minutos;
 * - reconcilia Issues, usuários, Milestones e responsáveis atuais;
 * - sinaliza Labels atuais e histórico para REPROCESSAMENTO, mas NÃO os importa aqui.
 *
 * É necessário executar sequencialmente, sem chamadas concorrentes.
 * Proteja a invocação com autenticação e autorização administrativas no gateway/backend.
 */
const INTEGRATION_ID = "1cfb42c7-3676-4045-b63c-2ad876812575";
const GITLAB_URL = (Deno.env.get("GITLAB_URL") ?? "").trim().replace(/\/+$/, "");
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN") ?? "";
const GROUP_ID = Number(Deno.env.get("GITLAB_GROUP_ID"));

const FIRST_SYNC_FROM = "2026-01-01T00:00:00.000Z";
const OVERLAP_MS = 10 * 60 * 1000;
const PER_PAGE = 50;
const MAX_PAGES_PER_REQUEST = 4;
const MAX_DURATION_MS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type Json = Record<string, unknown>;
type GitlabUser = {
  id: number; name?: string | null; username?: string | null;
  avatar_url?: string | null; web_url?: string | null; state?: string | null;
};
type GitlabMilestone = {
  id: number; title?: string; state?: string | null;
  project_id?: number | null; group_id?: number | null;
  start_date?: string | null; due_date?: string | null;
};
type GitlabIssue = {
  id: number; iid: number; project_id: number; title: string;
  state: "opened" | "closed"; issue_type?: string | null;
  created_at: string; updated_at: string; closed_at?: string | null;
  web_url?: string | null; author?: GitlabUser | null;
  assignee?: GitlabUser | null; assignees?: GitlabUser[];
  milestone?: GitlabMilestone | null;
  labels?: (string | { name?: string; id?: number })[];
  [key: string]: unknown;
};
type ExistingIssue = {
  id: string;
  gitlab_id: number;
  updated_at_gitlab: string | null;
  raw_payload: { labels?: unknown } | null;
};
type Project = { id: string; gitlab_id: number; import_enabled: boolean };
type Cursor = {
  task: "reconcile"; since: string; until: string;
  page: number; complete: boolean;
};

type Processed = {
  imported: number; newIssues: number; modifiedIssues: number;
  labelsStale: number; historyStale: number; disabled: number;
  projects: number[];
};

function respond(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
function check(error: { message: string } | null): void {
  if (error) throw new Error(`Supabase: ${error.message}`);
}
function idNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`ID inválido: ${field}`);
  return n;
}
function validDate(date: unknown, field: string): string {
  if (typeof date !== "string" || !Number.isFinite(Date.parse(date))) {
    throw new Error(`Data inválida: ${field}`);
  }
  return new Date(date).toISOString();
}
function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => {
    if (typeof label === "string") return label;
    if (label && typeof label === "object") {
      const obj = label as { name?: unknown };
      if (typeof obj.name === "string") return obj.name;
    }
    return "";
  }).filter(Boolean).sort();
}
function labelsChanged(oldLabels: unknown, newLabels: unknown): boolean {
  return JSON.stringify(labelNames(oldLabels)) !== JSON.stringify(labelNames(newLabels));
}
function validateCursor(value: unknown): Cursor {
  const c = value as Partial<Cursor> | null;
  if (!c || c.task !== "reconcile") {
    throw new Error("Cursor reconcile inválido; verifique sync_cursors_gitlab");
  }
  const since = validDate(c.since, "cursor.since");
  const until = validDate(c.until, "cursor.until");
  const page = Number(c.page);
  if (Date.parse(since) > Date.parse(until) ||
      !Number.isSafeInteger(page) || page < 1) {
    throw new Error("Janela/página inválida no cursor reconcile");
  }
  return { task: "reconcile", since, until, page, complete: c.complete === true };
}
async function ensureIntegration(): Promise<void> {
  if (!GITLAB_URL.startsWith("https://") || !GITLAB_TOKEN ||
      !Number.isSafeInteger(GROUP_ID) || GROUP_ID <= 0) {
    throw new Error("GITLAB_URL (HTTPS), GITLAB_TOKEN e GITLAB_GROUP_ID são obrigatórios");
  }
  const { data, error } = await db.from("integrations_gitlab")
    .select("id,base_url,is_active")
    .eq("id", INTEGRATION_ID).single();
  check(error);
  if (!data?.is_active ||
      String(data.base_url ?? "").trim().replace(/\/+$/, "") !== GITLAB_URL) {
    throw new Error("Integração fixa inativa, inexistente ou com URL divergente do secret");
  }
}
async function loadProjects(): Promise<Map<number, Project>> {
  const projects = new Map<number, Project>();
  for (let start = 0;; start += 500) {
    const { data, error } = await db.from("projects_gitlab")
      .select("id,gitlab_id,import_enabled")
      .eq("integration_id", INTEGRATION_ID)
      .order("gitlab_id", { ascending: true })
      .range(start, start + 499);
    check(error);
    for (const item of data ?? []) projects.set(Number(item.gitlab_id), item as Project);
    if ((data ?? []).length < 500) break;
  }
  if (projects.size === 0) throw new Error("Nenhum projeto importado; execute projects GitLab primeiro");
  return projects;
}
async function loadGroups(): Promise<Map<number, string>> {
  const groups = new Map<number, string>();
  for (let start = 0;; start += 500) {
    const { data, error } = await db.from("groups_gitlab")
      .select("id,gitlab_id").eq("integration_id", INTEGRATION_ID)
      .order("gitlab_id", { ascending: true })
      .range(start, start + 499);
    check(error);
    for (const item of data ?? []) groups.set(Number(item.gitlab_id), item.id);
    if ((data ?? []).length < 500) break;
  }
  if (!groups.has(GROUP_ID)) throw new Error(`Grupo ${GROUP_ID} não cadastrado; importe grupos primeiro`);
  return groups;
}
async function readCursor(): Promise<{ id: string | null; progress: Cursor; startedNewCycle: boolean }> {
  const { data, error } = await db.from("sync_cursors_gitlab")
    .select("id,cursor,last_successful_at")
    .eq("integration_id", INTEGRATION_ID)
    .eq("sync_type", "reconcile")
    .is("project_id", null)
    .maybeSingle();
  check(error);
  if (data?.cursor) {
    const progress = validateCursor(data.cursor);
    if (!progress.complete) return { id: data.id, progress, startedNewCycle: false };
  }
  // Primeiro ciclo: desde janeiro de 2026. Próximos ciclos: janela incremental
  // sobreposta, reavaliando parte do fim da rodada anterior.
  const previous = data?.last_successful_at;
  const startMs = previous
    ? Math.max(Date.parse(FIRST_SYNC_FROM), Date.parse(validDate(previous, "last_successful_at")) - OVERLAP_MS)
    : Date.parse(FIRST_SYNC_FROM);
  const progress: Cursor = {
    task: "reconcile",
    since: new Date(startMs).toISOString(),
    until: new Date().toISOString(),
    page: 1,
    complete: false,
  };
  return { id: data?.id ?? null, progress, startedNewCycle: true };
}
async function saveCursor(cursorId: string | null, progress: Cursor): Promise<string> {
  const now = new Date().toISOString();
  if (cursorId) {
    const update: Json = { cursor: progress, updated_at: now };
    if (progress.complete) update.last_successful_at = progress.until;
    const { error } = await db.from("sync_cursors_gitlab")
      .update(update).eq("id", cursorId).eq("integration_id", INTEGRATION_ID);
    check(error);
    return cursorId;
  }
  const { data, error } = await db.from("sync_cursors_gitlab").insert({
    integration_id: INTEGRATION_ID,
    project_id: null,
    sync_type: "reconcile",
    cursor: progress,
    updated_at: now,
    last_successful_at: progress.complete ? progress.until : null,
  }).select("id").single();
  check(error);
  return data!.id;
}
async function fetchIssues(progress: Cursor): Promise<{ items: GitlabIssue[]; nextPage: number }> {
  const url = new URL(`${GITLAB_URL}/api/v4/groups/${GROUP_ID}/issues`);
  for (const [key, value] of Object.entries({
    state: "all", scope: "all", non_archived: "false",
    updated_after: progress.since,
    updated_before: progress.until,
    order_by: "updated_at", sort: "asc",
    per_page: String(PER_PAGE), page: String(progress.page),
  })) url.searchParams.set(key, value);

  let response: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await fetch(url, {
        headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      continue;
    }
    if (response.ok) break;
    if (![429, 502, 503, 504].includes(response.status) || attempt === 3) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`GitLab HTTP ${response.status} página ${progress.page}: ${detail}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 3000)
      : attempt * 500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (!response?.ok) throw new Error("GitLab indisponível após retentativas");
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("GitLab retornou uma lista de Issues inválida");
  const header = response.headers.get("x-next-page");
  const nextPage = header !== null
    ? Number(header || "0")
    : body.length === PER_PAGE ? progress.page + 1 : 0;
  if (!Number.isSafeInteger(nextPage) || nextPage < 0) {
    throw new Error("Paginação inválida retornada pelo GitLab");
  }
  return { items: body as GitlabIssue[], nextPage };
}
async function reconcilePage(
  received: GitlabIssue[],
  projects: Map<number, Project>,
  groups: Map<number, string>,
): Promise<Processed> {
  const output: Processed = {
    imported: 0, newIssues: 0, modifiedIssues: 0,
    labelsStale: 0, historyStale: 0, disabled: 0, projects: [],
  };
  if (!received.length) return output;
  const projectIds = [...new Set(received.map((i) => idNumber(i.project_id, "issue.project_id")))];
  const missing = projectIds.filter((id) => !projects.has(id));
  if (missing.length) {
    throw new Error(
      `Projetos ausentes em projects_gitlab: ${missing.join(", ")}. ` +
      "Importe/atualize os projetos do grupo 320 e repita a requisição.",
    );
  }
  const activeIssues = received.filter((issue) => {
    const enabled = projects.get(Number(issue.project_id))!.import_enabled;
    if (!enabled) output.disabled++;
    return enabled;
  });
  if (activeIssues.length === 0) return output;

  for (const issue of activeIssues) {
    idNumber(issue.id, "issue.id");
    idNumber(issue.iid, "issue.iid");
    if (!issue.title || !["opened", "closed"].includes(issue.state)) {
      throw new Error(`Issue GitLab ${issue.id}: título/estado inválido`);
    }
    validDate(issue.created_at, `Issue ${issue.id}: created_at`);
    validDate(issue.updated_at, `Issue ${issue.id}: updated_at`);
  }
  const now = new Date().toISOString();
  const ids = activeIssues.map((i) => i.id);
  const { data: oldRows, error: oldError } = await db.from("issues_gitlab")
    .select("id,gitlab_id,updated_at_gitlab,raw_payload")
    .eq("integration_id", INTEGRATION_ID).in("gitlab_id", ids);
  check(oldError);
  const existing = new Map<number, ExistingIssue>((oldRows ?? []).map((i) => [Number(i.gitlab_id), i as ExistingIssue]));
  const users = new Map<number, Json>();
  const milestones = new Map<number, Json>();
  const rows: Json[] = [];
  const needsLabels = new Set<number>();
  const needsHistory = new Set<number>();

  for (const issue of activeIssues) {
    const project = projects.get(Number(issue.project_id))!;
    for (const user of [issue.author, issue.assignee, ...(issue.assignees ?? [])]) {
      if (user?.id == null) continue;
      const externalId = idNumber(user.id, "user.id");
      users.set(externalId, {
        integration_id: INTEGRATION_ID,
        gitlab_id: externalId,
        name: user.name || user.username || `Usuário ${externalId}`,
        username: user.username ?? null,
        avatar_url: user.avatar_url ?? null,
        web_url: user.web_url ?? null,
        state: user.state ?? null,
        synced_at: now,
      });
    }
    const m = issue.milestone;
    if (m?.id) {
      const milestoneId = idNumber(m.id, "milestone.id");
      milestones.set(milestoneId, {
        integration_id: INTEGRATION_ID,
        gitlab_id: milestoneId,
        title: m.title || `Milestone ${milestoneId}`,
        state: m.state ?? null,
        project_id: m.project_id != null ? projects.get(Number(m.project_id))?.id ?? null : null,
        group_id: m.group_id != null ? groups.get(Number(m.group_id)) ?? null : null,
        start_date: m.start_date ?? null,
        due_date: m.due_date ?? null,
        synced_at: now,
      });
    }
    const before = existing.get(Number(issue.id));
    const staleCurrentLabels = !before || labelsChanged(before.raw_payload?.labels, issue.labels);
    const staleHistory = !before ||
      Date.parse(before.updated_at_gitlab || "") !== Date.parse(issue.updated_at);
    if (!before) output.newIssues++;
    else if (staleHistory) output.modifiedIssues++;
    if (staleCurrentLabels) {
      needsLabels.add(Number(issue.id));
      output.labelsStale++;
    }
    if (staleHistory) {
      needsHistory.add(Number(issue.id));
      output.historyStale++;
    }

    const row: Json = {
      integration_id: INTEGRATION_ID,
      gitlab_id: issue.id,
      project_id: project.id,
      iid: issue.iid,
      title: issue.title,
      state: issue.state,
      issue_type: issue.issue_type ?? null,
      created_at_gitlab: issue.created_at,
      updated_at_gitlab: issue.updated_at,
      closed_at: issue.closed_at ?? null,
      web_url: issue.web_url ?? null,
      synced_at: now,
      raw_payload: issue,
    };
    // Somente anula os indicadores de sincronização quando realmente ficaram obsoletos.
    // A reconciliação NÃO apaga nem recompõe os dados nas tabelas de Labels/eventos.
    if (staleCurrentLabels) row.labels_synced_at = null;
    if (staleHistory) row.label_events_synced_at = null;
    rows.push(row);
  }

  if (users.size) {
    const { error } = await db.from("users_gitlab")
      .upsert([...users.values()], { onConflict: "integration_id,gitlab_id" });
    check(error);
  }
  if (milestones.size) {
    const { error } = await db.from("milestones_gitlab")
      .upsert([...milestones.values()], { onConflict: "integration_id,gitlab_id" });
    check(error);
  }
  const userKeys = [...users.keys()];
  const milestoneKeys = [...milestones.keys()];
  const { data: usersFound, error: usersError } = userKeys.length
    ? await db.from("users_gitlab").select("id,gitlab_id")
      .eq("integration_id", INTEGRATION_ID).in("gitlab_id", userKeys)
    : { data: [], error: null };
  check(usersError);
  const { data: milestonesFound, error: milestonesError } = milestoneKeys.length
    ? await db.from("milestones_gitlab").select("id,gitlab_id")
      .eq("integration_id", INTEGRATION_ID).in("gitlab_id", milestoneKeys)
    : { data: [], error: null };
  check(milestonesError);
  const userMap = new Map<number, string>((usersFound ?? []).map((u: { gitlab_id: number; id: string }) => [Number(u.gitlab_id), u.id] as [number, string]));
  const milestoneMap = new Map<number, string>((milestonesFound ?? []).map((m: { gitlab_id: number; id: string }) => [Number(m.gitlab_id), m.id] as [number, string]));

  for (let index = 0; index < activeIssues.length; index++) {
    const issue = activeIssues[index];
    const firstAssignee = issue.assignee ?? issue.assignees?.[0] ?? null;
    rows[index].author_id = userMap.get(Number(issue.author?.id)) ?? null;
    rows[index].primary_assignee_id = userMap.get(Number(firstAssignee?.id)) ?? null;
    rows[index].milestone_id = milestoneMap.get(Number(issue.milestone?.id)) ?? null;
  }
  const { error: issueError } = await db.from("issues_gitlab")
    .upsert(rows, { onConflict: "integration_id,gitlab_id" });
  check(issueError);

  // Reconciliação de responsáveis, incluindo remoções.
  const { data: persisted, error: persistedError } = await db.from("issues_gitlab")
    .select("id,gitlab_id").eq("integration_id", INTEGRATION_ID)
    .in("gitlab_id", ids);
  check(persistedError);
  if ((persisted ?? []).length !== activeIssues.length) {
    throw new Error("Nem todas as Issues puderam ser recuperadas após upsert");
  }
  const issueMap = new Map<number, string>((persisted ?? []).map((i: { gitlab_id: number; id: string }) => [Number(i.gitlab_id), i.id] as [number, string]));
  const { error: removeError } = await db.from("issue_assignees_gitlab")
    .delete().in("issue_id", [...issueMap.values()]);
  check(removeError);
  const assignees = new Map<string, { issue_id: string; user_id: string }>();
  for (const issue of activeIssues) {
    const issueId = issueMap.get(Number(issue.id))!;
    const people = issue.assignees ?? (issue.assignee ? [issue.assignee] : []);
    for (const user of people) {
      const userId = userMap.get(Number(user.id));
      if (!userId) throw new Error(`Responsável ${user.id} não cadastrado da Issue ${issue.id}`);
      assignees.set(`${issueId}/${userId}`, { issue_id: issueId, user_id: userId });
    }
  }
  if (assignees.size) {
    const { error } = await db.from("issue_assignees_gitlab")
      .upsert([...assignees.values()], { onConflict: "issue_id,user_id" });
    check(error);
  }
  output.imported = activeIssues.length;
  output.projects = [...new Set(activeIssues.map((i) => Number(i.project_id)))];
  return output;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond({ ok: true });
  if (req.method !== "POST") return respond({ error: "Use POST" }, 405);

  const start = Date.now();
  let currentPage = 1;
  let progress: Cursor | null = null;
  try {
    await ensureIntegration();
    const projects = await loadProjects();
    const groups = await loadGroups();
    const loaded = await readCursor();
    let cursorId = loaded.id;
    progress = loaded.progress;
    const startedNewCycle = loaded.startedNewCycle;
    let pages = 0;
    let total = 0;
    let created = 0;
    let changed = 0;
    let staleLabels = 0;
    let staleHistory = 0;
    let skippedDisabled = 0;
    const touchedProjects = new Set<number>();

    while (pages < MAX_PAGES_PER_REQUEST && Date.now() - start < MAX_DURATION_MS) {
      currentPage = progress.page;
      const { items, nextPage } = await fetchIssues(progress);
      const result = await reconcilePage(items, projects, groups);
      pages++;
      total += result.imported;
      created += result.newIssues;
      changed += result.modifiedIssues;
      staleLabels += result.labelsStale;
      staleHistory += result.historyStale;
      skippedDisabled += result.disabled;
      for (const projectId of result.projects) touchedProjects.add(projectId);

      progress = nextPage > 0
        ? { ...progress, page: nextPage }
        : { ...progress, complete: true };
      // Checkpoint somente depois que toda a página e as relações foram persistidas.
      cursorId = await saveCursor(cursorId, progress);
      console.info("gitlab-reconcile-issues", {
        page: currentPage, received: items.length,
        imported: result.imported, new: result.newIssues,
        updated: result.modifiedIssues, labels_stale: result.labelsStale,
        history_stale: result.historyStale,
        next_page: nextPage,
      });
      if (progress.complete) break;
    }

    return respond({
      integration_id: INTEGRATION_ID,
      group_id: GROUP_ID,
      window: { updated_after: progress.since, updated_before: progress.until },
      started_new_cycle: startedNewCycle,
      pages_processed: pages,
      issues_processed: total,
      issues_new: created,
      issues_modified: changed,
      issues_flagged_current_labels: staleLabels,
      issues_flagged_label_history: staleHistory,
      issues_skipped_disabled_projects: skippedDisabled,
      project_gitlab_ids_touched: [...touchedProjects].sort((a, b) => a - b),
      next: progress,
      complete: progress.complete,
      resume_required: !progress.complete,
      duration_ms: Date.now() - start,
      notice: "Marcadores NULL indicam necessidade de reprocessar Labels. As funções atuais de Labels não consultam esses marcadores automaticamente; veja README.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("gitlab-reconcile-issues", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
      page: currentPage,
      progress,
    });
    return respond({
      error: message,
      page: currentPage,
      next: progress,
      hint: "Cursor só avança após persistência integral da página; corrija o erro e repita POST {}.",
    }, 500);
  }
});
