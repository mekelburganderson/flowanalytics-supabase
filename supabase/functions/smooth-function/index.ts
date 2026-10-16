import { createClient } from "npm:@supabase/supabase-js@2.57.0";

/**
 * Flow Analytics — Importação de Issues do grupo GitLab 320.
 *
 * POST {} (sem parâmetros no body).
 * Busca todas as Issues acessíveis do grupo, sem iterar projeto a projeto:
 * GET /api/v4/groups/:group_id/issues
 *
 * A importação respeita meses de criação de 2026 e mantém checkpoint
 * após cada página concluída. Uma chamada tenta processar várias páginas
 * de vários projetos, mas encerra ao alcançar o orçamento de tempo/páginas.
 */
const INTEGRATION_ID = "1cfb42c7-3676-4045-b63c-2ad876812575";
const YEAR = 2026;
const PER_PAGE = 50;
const MAX_PAGES_PER_INVOCATION = 12;
const MAX_DURATION_MS = 90_000;
const GITLAB_URL = (Deno.env.get("GITLAB_URL") ?? "").trim().replace(/\/+$/, "");
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN") ?? "";
const GROUP_ID = Number(Deno.env.get("GITLAB_GROUP_ID"));

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type ApiIssue = Record<string, any>;
type Project = { id: string; gitlab_id: number; name: string; import_enabled: boolean };
type Progress = { mode: "group"; year: number; month: number; page: number; complete: boolean };

type DbError = { message: string } | null;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function check(error: DbError) {
  if (error) throw new Error(`Supabase: ${error.message}`);
}

function monthRange(month: number) {
  const start = new Date(Date.UTC(YEAR, month - 1, 1));
  const endInclusive = new Date(Date.UTC(YEAR, month, 1) - 1);
  return { start: start.toISOString(), end: endInclusive.toISOString() };
}

async function gitlab(path: string): Promise<Response> {
  const response = await fetch(`${GITLAB_URL}/api/v4${path}`, {
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`GitLab HTTP ${response.status}: ${detail}`);
  }
  return response;
}

async function listProjects(): Promise<Map<number, Project>> {
  const all = new Map<number, Project>();
  for (let from = 0;; from += 500) {
    const { data, error } = await db.from("projects_gitlab")
      .select("id,gitlab_id,name,import_enabled")
      .eq("integration_id", INTEGRATION_ID)
      .order("gitlab_id", { ascending: true })
      .range(from, from + 499);
    check(error);
    for (const project of data ?? []) {
      all.set(Number(project.gitlab_id), project as Project);
    }
    if ((data ?? []).length < 500) return all;
  }
}

async function listGroups(): Promise<Map<number, string>> {
  const groups = new Map<number, string>();
  for (let from = 0;; from += 500) {
    const { data, error } = await db.from("groups_gitlab")
      .select("id,gitlab_id").eq("integration_id", INTEGRATION_ID)
      .range(from, from + 499);
    check(error);
    for (const group of data ?? []) groups.set(Number(group.gitlab_id), group.id);
    if ((data ?? []).length < 500) return groups;
  }
}

async function saveCursor(cursorId: string | null, cursor: Progress): Promise<string> {
  const now = new Date().toISOString();
  const row = {
    integration_id: INTEGRATION_ID,
    project_id: null,
    sync_type: "issues",
    cursor,
    updated_at: now,
    last_successful_at: cursor.complete ? now : null,
  };
  if (cursorId) {
    const { error } = await db.from("sync_cursors_gitlab").update(row).eq("id", cursorId);
    check(error);
    return cursorId;
  }
  const { data, error } = await db.from("sync_cursors_gitlab").insert(row).select("id").single();
  check(error);
  return data!.id;
}

async function persistIssues(
  received: ApiIssue[],
  projectMap: Map<number, Project>,
  groupMap: Map<number, string>,
): Promise<{ imported: number; skippedDisabled: number; projectsAffected: number[] }> {
  if (!received.length) return { imported: 0, skippedDisabled: 0, projectsAffected: [] };

  // Sem vínculo FK válido a importação não é registrada como concluída.
  // Execute a importação de projetos (com subgrupos) antes de importar Issues.
  const unknownIds = [...new Set(received
    .map((issue) => Number(issue.project_id))
    .filter((id) => !projectMap.has(id)))];
  if (unknownIds.length) {
    throw new Error(
      `Projetos não cadastrados em projects_gitlab: ${unknownIds.slice(0, 20).join(", ")}. ` +
      "Execute/atualize gitlab-import-projects para o grupo 320 antes desta importação.",
    );
  }

  const issues = received.filter((issue) => projectMap.get(Number(issue.project_id))?.import_enabled);
  const skippedDisabled = received.length - issues.length;
  if (!issues.length) return { imported: 0, skippedDisabled, projectsAffected: [] };
  const now = new Date().toISOString();
  const users = new Map<number, Record<string, unknown>>();
  const milestones = new Map<number, Record<string, unknown>>();

  for (const issue of issues) {
    const project = projectMap.get(Number(issue.project_id))!;
    for (const user of [issue.author, issue.assignee, ...(issue.assignees ?? [])]) {
      if (user?.id == null) continue;
      users.set(Number(user.id), {
        integration_id: INTEGRATION_ID,
        gitlab_id: user.id,
        name: user.name ?? user.username ?? "Usuário",
        username: user.username ?? null,
        avatar_url: user.avatar_url ?? null,
        web_url: user.web_url ?? null,
        state: user.state ?? null,
        synced_at: now,
      });
    }
    const m = issue.milestone;
    if (m?.id != null) {
      milestones.set(Number(m.id), {
        integration_id: INTEGRATION_ID,
        gitlab_id: m.id,
        title: m.title,
        state: m.state ?? null,
        project_id: m.project_id != null
          ? projectMap.get(Number(m.project_id))?.id ?? project.id
          : null,
        group_id: m.group_id != null ? groupMap.get(Number(m.group_id)) ?? null : null,
        start_date: m.start_date ?? null,
        due_date: m.due_date ?? null,
        synced_at: now,
      });
    }
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

  const ids = [...users.keys()];
  const mids = [...milestones.keys()];
  const { data: dbUsers, error: userError } = ids.length
    ? await db.from("users_gitlab").select("id,gitlab_id")
      .eq("integration_id", INTEGRATION_ID).in("gitlab_id", ids)
    : { data: [], error: null };
  check(userError);
  const { data: dbMilestones, error: milestoneError } = mids.length
    ? await db.from("milestones_gitlab").select("id,gitlab_id")
      .eq("integration_id", INTEGRATION_ID).in("gitlab_id", mids)
    : { data: [], error: null };
  check(milestoneError);
  const userIdMap = new Map((dbUsers ?? []).map((u) => [Number(u.gitlab_id), u.id]));
  const milestoneIdMap = new Map((dbMilestones ?? []).map((m) => [Number(m.gitlab_id), m.id]));

  const rows = issues.map((issue) => ({
    integration_id: INTEGRATION_ID,
    project_id: projectMap.get(Number(issue.project_id))!.id,
    gitlab_id: issue.id,
    iid: issue.iid,
    title: issue.title,
    state: issue.state,
    issue_type: issue.issue_type ?? null,
    author_id: userIdMap.get(Number(issue.author?.id)) ?? null,
    primary_assignee_id: userIdMap.get(Number(issue.assignee?.id)) ??
      userIdMap.get(Number(issue.assignees?.[0]?.id)) ?? null,
    milestone_id: milestoneIdMap.get(Number(issue.milestone?.id)) ?? null,
    created_at_gitlab: issue.created_at,
    updated_at_gitlab: issue.updated_at,
    closed_at: issue.closed_at ?? null,
    web_url: issue.web_url ?? null,
    synced_at: now,
    raw_payload: issue,
  }));
  const { error: issueUpsertError } = await db.from("issues_gitlab")
    .upsert(rows, { onConflict: "integration_id,gitlab_id" });
  check(issueUpsertError);

  const { data: persisted, error: issueLookupError } = await db.from("issues_gitlab")
    .select("id,gitlab_id")
    .eq("integration_id", INTEGRATION_ID)
    .in("gitlab_id", issues.map((i) => i.id));
  check(issueLookupError);
  const issueIdMap = new Map((persisted ?? []).map((i) => [Number(i.gitlab_id), i.id]));
  if (issueIdMap.size !== issues.length) {
    throw new Error("Não foi possível recuperar os IDs internos de todas as Issues importadas");
  }

  // Estado atual dos responsáveis: idempotente mesmo após reprocessamento.
  const issueDbIds = [...issueIdMap.values()];
  const { error: relationsDeleteError } = await db.from("issue_assignees_gitlab")
    .delete().in("issue_id", issueDbIds);
  check(relationsDeleteError);
  const relations = new Map<string, { issue_id: string; user_id: string }>();
  for (const issue of issues) {
    const issueId = issueIdMap.get(Number(issue.id))!;
    for (const user of issue.assignees ?? (issue.assignee ? [issue.assignee] : [])) {
      const userId = userIdMap.get(Number(user.id));
      if (!userId) continue;
      relations.set(`${issueId}:${userId}`, { issue_id: issueId, user_id: userId });
    }
  }
  if (relations.size) {
    const { error } = await db.from("issue_assignees_gitlab")
      .upsert([...relations.values()], { onConflict: "issue_id,user_id" });
    check(error);
  }
  return {
    imported: issues.length,
    skippedDisabled,
    projectsAffected: [...new Set(issues.map((issue) => Number(issue.project_id)))],
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const started = Date.now();

  try {
    if (!/^https?:\/\//i.test(GITLAB_URL) || !GITLAB_TOKEN ||
        !Number.isSafeInteger(GROUP_ID) || GROUP_ID <= 0) {
      throw new Error("Configure GITLAB_URL, GITLAB_TOKEN e GITLAB_GROUP_ID nos secrets");
    }
    const { data: integration, error: integrationError } = await db
      .from("integrations_gitlab").select("id,base_url,is_active")
      .eq("id", INTEGRATION_ID).single();
    check(integrationError);
    if (!integration?.is_active ||
        integration.base_url.trim().replace(/\/+$/, "") !== GITLAB_URL) {
      return json({ error: "Integração inativa ou URL divergente" }, 400);
    }

    const projects = await listProjects();
    if (!projects.size) {
      return json({ error: "Nenhum projeto cadastrado. Importe os projetos primeiro." }, 409);
    }
    const groups = await listGroups();
    const { data: saved, error: cursorError } = await db.from("sync_cursors_gitlab")
      .select("id,cursor").eq("integration_id", INTEGRATION_ID)
      .eq("sync_type", "issues").is("project_id", null).maybeSingle();
    check(cursorError);

    // O cursor antigo percorria projeto a projeto: NÃO podemos utilizar sua página.
    // Na primeira chamada desta versão, reiniciamos janeiro de 2026 de forma idempotente.
    const oldCursor = saved?.cursor as Record<string, unknown> | null | undefined;
    const migratedFromPerProject = !!oldCursor && oldCursor.mode !== "group";
    let progress: Progress = !migratedFromPerProject && oldCursor
      ? {
        mode: "group", year: YEAR,
        month: Number(oldCursor.month ?? 1),
        page: Number(oldCursor.page ?? 1),
        complete: oldCursor.complete === true,
      }
      : { mode: "group", year: YEAR, month: 1, page: 1, complete: false };

    if (!Number.isInteger(progress.month) || progress.month < 1 || progress.month > 12 ||
        !Number.isInteger(progress.page) || progress.page < 1) {
      throw new Error("Cursor de importação inválido");
    }
    if (progress.complete) {
      return json({ complete: true, issues_imported: 0, message: `Todas as páginas de ${YEAR} já foram processadas.` });
    }

    let cursorId = saved?.id ?? null;
    let pagesProcessed = 0;
    let issuesImported = 0;
    let issuesSkippedDisabled = 0;
    const touched = new Set<number>();
    const monthsCompleted: number[] = [];

    while (pagesProcessed < MAX_PAGES_PER_INVOCATION && Date.now() - started < MAX_DURATION_MS) {
      const { start, end } = monthRange(progress.month);
      const params = new URLSearchParams({
        state: "all", scope: "all", non_archived: "false",
        created_after: start, created_before: end,
        per_page: String(PER_PAGE), page: String(progress.page),
        order_by: "created_at", sort: "asc",
      });
      // Uma chamada busca Issues de TODOS os projetos do grupo, não de um único projeto.
      const response = await gitlab(`/groups/${GROUP_ID}/issues?${params.toString()}`);
      const issues: ApiIssue[] = await response.json();
      if (!Array.isArray(issues)) throw new Error("Resposta inesperada da API de Issues do GitLab");
      const result = await persistIssues(issues, projects, groups);
      issuesImported += result.imported;
      issuesSkippedDisabled += result.skippedDisabled;
      for (const id of result.projectsAffected) touched.add(id);
      pagesProcessed++;

      const nextPageFromHeader = Number(response.headers.get("x-next-page") || 0);
      const hasNext = nextPageFromHeader > 0 ||
        (!response.headers.has("x-next-page") && issues.length === PER_PAGE);
      if (hasNext) {
        progress = { ...progress, page: nextPageFromHeader || progress.page + 1 };
      } else {
        monthsCompleted.push(progress.month);
        if (progress.month === 12) {
          progress = { ...progress, complete: true };
        } else {
          progress = { ...progress, month: progress.month + 1, page: 1 };
        }
      }
      // Só avança o checkpoint após concluir a persistência de toda a página.
      cursorId = await saveCursor(cursorId, progress);
      if (progress.complete) break;
    }

    return json({
      integration_id: INTEGRATION_ID,
      group_id: GROUP_ID,
      year: YEAR,
      pages_processed: pagesProcessed,
      issues_imported: issuesImported,
      issues_skipped_disabled_projects: issuesSkippedDisabled,
      projects_with_issues_processed: touched.size,
      project_gitlab_ids_processed: [...touched].sort((a, b) => a - b),
      months_completed_in_this_request: monthsCompleted,
      next: progress,
      complete: progress.complete,
      resume_required: !progress.complete,
      migrated_from_project_cursor: migratedFromPerProject,
      duration_ms: Date.now() - started,
      notice: "Consulta única por grupo com paginação. Labels atuais permanecem em raw_payload; histórico de Labels será importado separadamente.",
    });
  } catch (e) {
    console.error("gitlab-import-issues (group)", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
