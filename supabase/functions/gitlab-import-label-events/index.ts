import { createClient } from "npm:@supabase/supabase-js@2.57.0";

/**
 * Flow Analytics — Importação do histórico de Labels do GitLab.
 *
 * POST {} — sem parâmetros no body.
 * Integração fixa, grupo configurado por GITLAB_GROUP_ID (320).
 * Percorre todas as Issues já importadas de todos os projetos habilitados
 * do grupo 320 e seus subgrupos.
 *
 * Fonte: GET /api/v4/projects/:project_id/issues/:iid/resource_label_events
 * Cursor global: sync_cursors_gitlab / sync_type = 'label_events'.
 * Uma execução importa até MAX_API_PAGES_PER_INVOCATION páginas.
 * Repetir POST {} até complete = true.
 *
 * IMPORTANTE: somente invocar a partir de contexto administrativo autorizado.
 * A função usa service_role no servidor; não a exponha publicamente.
 */

const INTEGRATION_ID = "1cfb42c7-3676-4045-b63c-2ad876812575";
const GITLAB_URL = (Deno.env.get("GITLAB_URL") ?? "").trim().replace(/\/+$/, "");
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN") ?? "";
const GROUP_ID = Number(Deno.env.get("GITLAB_GROUP_ID"));

const PER_PAGE = 800;
const MAX_API_PAGES_PER_INVOCATION = 800;
const MAX_DURATION_MS = 52_000;
const GITLAB_TIMEOUT_MS = 15_000;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type DbError = { message: string } | null;
type JsonObject = Record<string, unknown>;
type GitlabUser = {
  id: number;
  name?: string | null;
  username?: string | null;
  avatar_url?: string | null;
  web_url?: string | null;
  state?: string | null;
};
type GitlabLabel = {
  id: number;
  name?: string | null;
  color?: string | null;
  description?: string | null;
};
type LabelEvent = {
  id: number;
  resource_type?: string;
  resource_id?: number;
  action: "add" | "remove";
  created_at: string;
  user?: GitlabUser | null;
  label?: GitlabLabel | null;
};
type DbIssue = {
  id: string;
  gitlab_id: number;
  iid: number;
  project_id: string;
};
type Cursor = {
  task: "label_events";
  last_issue_id: string | null;
  current_issue_id: string | null;
  page: number;
  complete: boolean;
};

function respond(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
function check(error: DbError): void {
  if (error) throw new Error(`Supabase: ${error.message}`);
}
function asPositiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function validateCursor(value: unknown): Cursor {
  const obj = value as Partial<Cursor> | null;
  if (!obj || obj.task !== "label_events") {
    throw new Error("Cursor global label_events inválido ou pertence a outra função");
  }
  const page = Number(obj.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error("Página inválida no cursor label_events");
  }
  return {
    task: "label_events",
    last_issue_id: obj.last_issue_id ?? null,
    current_issue_id: obj.current_issue_id ?? null,
    page,
    complete: obj.complete === true,
  };
}

async function ensureIntegration(): Promise<string> {
  if (!/^https?:\/\//i.test(GITLAB_URL) || !GITLAB_TOKEN ||
      !Number.isSafeInteger(GROUP_ID) || GROUP_ID <= 0) {
    throw new Error("Configure corretamente GITLAB_URL, GITLAB_TOKEN e GITLAB_GROUP_ID");
  }
  const { data: integration, error } = await db.from("integrations_gitlab")
    .select("id,base_url,is_active")
    .eq("id", INTEGRATION_ID).single();
  check(error);
  if (!integration?.is_active ||
      integration.base_url?.trim().replace(/\/+$/, "") !== GITLAB_URL) {
    throw new Error("Integração fixa não encontrada, inativa ou com URL diferente de GITLAB_URL");
  }
  const { data: root, error: groupError } = await db.from("groups_gitlab")
    .select("full_path")
    .eq("integration_id", INTEGRATION_ID)
    .eq("gitlab_id", GROUP_ID).single();
  check(groupError);
  if (!root?.full_path) {
    throw new Error(`Grupo ${GROUP_ID} não encontrado em groups_gitlab`);
  }
  return root.full_path;
}

async function projectLookup(rootPath: string): Promise<Map<string, number>> {
  const allowed = new Map<string, number>();
  const prefix = `${rootPath}/`;
  for (let from = 0;; from += 500) {
    const { data, error } = await db.from("projects_gitlab")
      .select("id,gitlab_id,path_with_namespace")
      .eq("integration_id", INTEGRATION_ID)
      .eq("import_enabled", true)
      .order("gitlab_id", { ascending: true })
      .range(from, from + 499);
    check(error);
    for (const project of data ?? []) {
      if (project.path_with_namespace?.startsWith(prefix)) {
        allowed.set(project.id, Number(project.gitlab_id));
      }
    }
    if ((data ?? []).length < 500) break;
  }
  if (allowed.size === 0) {
    throw new Error(`Nenhum projeto habilitado no grupo ${GROUP_ID}. Importe projetos primeiro.`);
  }
  return allowed;
}

async function gitlabEvents(projectId: number, iid: number, page: number):
  Promise<{ items: LabelEvent[]; nextPage: number }> {
  const url = new URL(`${GITLAB_URL}/api/v4/projects/${projectId}/issues/${iid}/resource_label_events`);
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  let response: Response | null = null;

  // Não avança o cursor após falhas HTTP ou de rede.
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch(url, {
      headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, Accept: "application/json" },
      signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
    });
    if (response.ok) break;
    if (![429, 502, 503, 504].includes(response.status) || attempt === 3) {
      const detail = (await response.text()).slice(0, 350);
      throw new Error(`GitLab HTTP ${response.status} em projeto ${projectId}, Issue #${iid}, página ${page}: ${detail}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 3000)
      : attempt * 600;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (!response?.ok) throw new Error("GitLab indisponível após tentativas");
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`Resposta inválida do GitLab para a Issue #${iid}`);
  }
  const header = response.headers.get("x-next-page");
  const nextPage = header !== null
    ? Number(header || 0)
    : payload.length === PER_PAGE ? page + 1 : 0;
  if (!Number.isSafeInteger(nextPage) || nextPage < 0) {
    throw new Error(`Paginação inválida do GitLab na Issue #${iid}`);
  }
  return { items: payload as LabelEvent[], nextPage };
}

async function nextIssue(lastIssueId: string | null): Promise<DbIssue | null> {
  let query = db.from("issues_gitlab")
    .select("id,gitlab_id,iid,project_id")
    .eq("integration_id", INTEGRATION_ID)
    .order("id", { ascending: true })
    .limit(1);
  if (lastIssueId) query = query.gt("id", lastIssueId);
  const { data, error } = await query;
  check(error);
  return (data?.[0] ?? null) as DbIssue | null;
}

async function getIssueById(id: string): Promise<DbIssue> {
  const { data, error } = await db.from("issues_gitlab")
    .select("id,gitlab_id,iid,project_id")
    .eq("integration_id", INTEGRATION_ID)
    .eq("id", id).single();
  check(error);
  return data as DbIssue;
}

async function persistEvents(issue: DbIssue, events: LabelEvent[]): Promise<number> {
  if (!events.length) return 0;
  const now = new Date().toISOString();
  const users = new Map<number, JsonObject>();
  const labels = new Map<number, JsonObject>();
  const eventIds = new Set<number>();

  for (const event of events) {
    const eventId = asPositiveInt(event?.id);
    if (!eventId || !["add", "remove"].includes(event.action) ||
        typeof event.created_at !== "string" ||
        !Number.isFinite(Date.parse(event.created_at))) {
      throw new Error(`Evento inválido na Issue GitLab ${issue.gitlab_id}`);
    }
    if (eventIds.has(eventId)) throw new Error(`Evento duplicado na mesma página: ${eventId}`);
    eventIds.add(eventId);
    if (event.resource_type && event.resource_type !== "Issue") {
      throw new Error(`Evento ${eventId} não pertence a uma Issue`);
    }
    if (event.resource_id != null && Number(event.resource_id) !== Number(issue.gitlab_id)) {
      throw new Error(`Evento ${eventId} aponta para outra Issue`);
    }
    const actorId = asPositiveInt(event.user?.id);
    if (actorId && event.user) {
      const user = event.user;
      users.set(actorId, {
        integration_id: INTEGRATION_ID,
        gitlab_id: actorId,
        name: user.name || user.username || `Usuário ${actorId}`,
        username: user.username ?? null,
        avatar_url: user.avatar_url ?? null,
        web_url: user.web_url ?? null,
        state: user.state ?? null,
        synced_at: now,
      });
    }
    const labelId = asPositiveInt(event.label?.id);
    // Não resolver pelo nome: duas Labels "Apoio" podem ter IDs diferentes.
    // Só complementamos o catálogo se o GitLab trouxer um nome utilizável.
    if (labelId && event.label?.name) {
      const label = event.label;
      labels.set(labelId, {
        integration_id: INTEGRATION_ID,
        gitlab_id: labelId,
        name: label.name,
        color: label.color ?? null,
        description: label.description ?? null,
        synced_at: now,
      });
    }
  }

  if (users.size) {
    const { error } = await db.from("users_gitlab")
      .upsert([...users.values()], { onConflict: "integration_id,gitlab_id", ignoreDuplicates: true });
    check(error);
  }
  if (labels.size) {
    const { error } = await db.from("labels_gitlab")
      .upsert([...labels.values()], { onConflict: "integration_id,gitlab_id", ignoreDuplicates: true });
    check(error);
  }
  const userIds = [...new Set(events.map((e) => asPositiveInt(e.user?.id)).filter((n): n is number => n !== null))];
  const labelIds = [...new Set(events.map((e) => asPositiveInt(e.label?.id)).filter((n): n is number => n !== null))];

  const { data: dbUsers, error: userError } = userIds.length
    ? await db.from("users_gitlab").select("id,gitlab_id")
      .eq("integration_id", INTEGRATION_ID).in("gitlab_id", userIds)
    : { data: [], error: null };
  check(userError);
  const { data: dbLabels, error: labelError } = labelIds.length
    ? await db.from("labels_gitlab").select("id,gitlab_id")
      .eq("integration_id", INTEGRATION_ID).in("gitlab_id", labelIds)
    : { data: [], error: null };
  check(labelError);
  const userMap = new Map((dbUsers ?? []).map((u) => [Number(u.gitlab_id), u.id]));
  const labelMap = new Map((dbLabels ?? []).map((l) => [Number(l.gitlab_id), l.id]));

  const rows = events.map((event) => ({
    integration_id: INTEGRATION_ID,
    issue_id: issue.id,
    gitlab_event_id: event.id,
    label_id: labelMap.get(Number(event.label?.id)) ?? null,
    label_gitlab_id: event.label?.id ?? null,
    label_name_snapshot: event.label?.name ?? null,
    action: event.action,
    actor_user_id: userMap.get(Number(event.user?.id)) ?? null,
    occurred_at: event.created_at,
    imported_at: now,
    raw_payload: event,
  }));
  const { error } = await db.from("label_events_gitlab")
    .upsert(rows, { onConflict: "integration_id,gitlab_event_id" });
  check(error);
  return rows.length;
}

async function readCursor(): Promise<{ id: string | null; cursor: Cursor }> {
  const { data, error } = await db.from("sync_cursors_gitlab")
    .select("id,cursor").eq("integration_id", INTEGRATION_ID)
    .eq("sync_type", "label_events").is("project_id", null)
    .maybeSingle();
  check(error);
  return {
    id: data?.id ?? null,
    cursor: data?.cursor
      ? validateCursor(data.cursor)
      : { task: "label_events", last_issue_id: null, current_issue_id: null, page: 1, complete: false },
  };
}

async function saveCursor(id: string | null, cursor: Cursor): Promise<string> {
  const now = new Date().toISOString();
  if (id) {
    const { error } = await db.from("sync_cursors_gitlab")
      .update({
        cursor,
        updated_at: now,
        last_successful_at: cursor.complete ? now : null,
      }).eq("id", id).eq("integration_id", INTEGRATION_ID);
    check(error);
    return id;
  }
  const { data, error } = await db.from("sync_cursors_gitlab")
    .insert({
      integration_id: INTEGRATION_ID,
      project_id: null,
      sync_type: "label_events",
      cursor,
      updated_at: now,
      last_successful_at: cursor.complete ? now : null,
    }).select("id").single();
  check(error);
  return data!.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return respond({ ok: true });
  if (req.method !== "POST") return respond({ error: "Use o método POST" }, 405);

  const started = Date.now();
  let currentIssue: DbIssue | null = null;
  let currentPage = 1;
  try {
    const rootPath = await ensureIntegration();
    const projects = await projectLookup(rootPath);
    const saved = await readCursor();
    let cursorId = saved.id;
    let cursor = saved.cursor;

    if (cursor.complete) {
      return respond({
        complete: true,
        resume_required: false,
        message: "Importação de eventos já concluída. Nenhum registro reprocessado.",
      });
    }

    let apiPagesProcessed = 0;
    let issuesCompleted = 0;
    let eventsProcessed = 0;
    let issuesSkipped = 0;
    const projectsTouched = new Set<number>();

    while (apiPagesProcessed < MAX_API_PAGES_PER_INVOCATION &&
           Date.now() - started < MAX_DURATION_MS) {
      currentIssue = cursor.current_issue_id
        ? await getIssueById(cursor.current_issue_id)
        : await nextIssue(cursor.last_issue_id);
      if (!currentIssue) {
        cursor = { ...cursor, current_issue_id: null, page: 1, complete: true };
        cursorId = await saveCursor(cursorId, cursor);
        break;
      }

      const gitlabProjectId = projects.get(currentIssue.project_id);
      if (!gitlabProjectId) {
        // Issues de projetos fora do grupo/desabilitados não devem ser importadas.
        // Avançar é seguro apenas para o escopo declarado desta importação.
        issuesSkipped++;
        console.warn(`Issue ${currentIssue.gitlab_id} ignorada: projeto não pertence ao grupo ${GROUP_ID} habilitado`);
        cursor = {
          task: "label_events", last_issue_id: currentIssue.id,
          current_issue_id: null, page: 1, complete: false,
        };
        cursorId = await saveCursor(cursorId, cursor);
        continue;
      }

      currentPage = cursor.current_issue_id ? cursor.page : 1;
      const { items, nextPage } = await gitlabEvents(gitlabProjectId, currentIssue.iid, currentPage);
      eventsProcessed += await persistEvents(currentIssue, items);
      apiPagesProcessed++;
      projectsTouched.add(gitlabProjectId);

      if (nextPage > 0) {
        cursor = {
          task: "label_events", last_issue_id: cursor.last_issue_id,
          current_issue_id: currentIssue.id, page: nextPage, complete: false,
        };
      } else {
        const { error } = await db.from("issues_gitlab")
          .update({ label_events_synced_at: new Date().toISOString() })
          .eq("id", currentIssue.id).eq("integration_id", INTEGRATION_ID);
        check(error);
        issuesCompleted++;
        cursor = {
          task: "label_events", last_issue_id: currentIssue.id,
          current_issue_id: null, page: 1, complete: false,
        };
      }
      cursorId = await saveCursor(cursorId, cursor);
      console.log(`Histórico Issue #${currentIssue.iid} (projeto ${gitlabProjectId}): página ${currentPage}, ${items.length} eventos, próxima ${nextPage || "fim"}`);
    }

    return respond({
      integration_id: INTEGRATION_ID,
      group_id: GROUP_ID,
      api_pages_processed: apiPagesProcessed,
      issues_completed: issuesCompleted,
      issues_skipped_outside_scope: issuesSkipped,
      events_processed: eventsProcessed,
      projects_touched: [...projectsTouched],
      next: cursor,
      complete: cursor.complete,
      resume_required: !cursor.complete,
      duration_ms: Date.now() - started,
      notice: "events_processed conta eventos encontrados/regravados, não apenas eventos novos. Não execute esta função em paralelo.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("gitlab-import-label-events", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
      issue_gitlab_id: currentIssue?.gitlab_id ?? null,
      issue_iid: currentIssue?.iid ?? null,
      page: currentPage,
    });
    return respond({
      error: message,
      issue_gitlab_id: currentIssue?.gitlab_id ?? null,
      issue_iid: currentIssue?.iid ?? null,
      page: currentPage,
      hint: "O cursor não avança para a próxima página quando há erro de API ou banco.",
    }, 500);
  }
});
