import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const INTEGRATION_ID = "1cfb42c7-3676-4045-b63c-2ad876812575";
const GITLAB_URL = (Deno.env.get("GITLAB_URL") ?? "").trim().replace(/\/+$/, "");
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN") ?? "";
const GROUP_ID = Number(Deno.env.get("GITLAB_GROUP_ID"));
const MAX_DURATION_MS = 60_000;
const PER_PAGE = 100;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Item = Record<string, any>;
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function check(error: { message: string } | null): void {
  if (error) throw new Error(`Supabase: ${error.message}`);
}
async function ensureIntegration(): Promise<void> {
  if (!/^https?:\/\//i.test(GITLAB_URL) || !GITLAB_TOKEN || !Number.isSafeInteger(GROUP_ID) || GROUP_ID <= 0) {
    throw new Error("Secrets GITLAB_URL, GITLAB_TOKEN ou GITLAB_GROUP_ID inválidos");
  }
  const { data, error } = await db.from("integrations_gitlab")
    .select("id,base_url,is_active").eq("id", INTEGRATION_ID).single();
  check(error);
  if (!data?.is_active || data.base_url.trim().replace(/\/+$/, "") !== GITLAB_URL) {
    throw new Error("Integração inativa ou URL diferente do secret GITLAB_URL");
  }
}
async function gitlab(path: string): Promise<Response> {
  const response = await fetch(`${GITLAB_URL}/api/v4${path}`, {
    headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`GitLab HTTP ${response.status} em ${path}: ${detail}`);
  }
  return response;
}
async function getPage(path: string): Promise<{ items: Item[]; next: number }> {
  const response = await gitlab(path);
  const items = await response.json();
  if (!Array.isArray(items)) throw new Error(`GitLab retornou dados inválidos: ${path}`);
  const next = Number(response.headers.get("x-next-page") || 0);
  // GitLab disponibiliza x-next-page; quando ausente, a página curta encerra a listagem.
  const page = Number(new URL(`${GITLAB_URL}/api/v4${path}`).searchParams.get("page") || 1);
  return { items, next: next || (!response.headers.has("x-next-page") && items.length === PER_PAGE ? page + 1 : 0) };
}
async function allProjects(): Promise<Array<{ id: string; gitlab_id: number }>> {
  const { data: root, error: rootError } = await db.from("groups_gitlab")
    .select("full_path").eq("integration_id", INTEGRATION_ID)
    .eq("gitlab_id", GROUP_ID).single();
  check(rootError);
  const prefix = `${root!.full_path}/`;
  const out: Array<{ id: string; gitlab_id: number }> = [];
  for (let offset = 0;; offset += 500) {
    const { data, error } = await db.from("projects_gitlab")
      .select("id,gitlab_id,path_with_namespace").eq("integration_id", INTEGRATION_ID)
      .eq("import_enabled", true).order("gitlab_id", { ascending: true }).range(offset, offset + 499);
    check(error);
    for (const project of data ?? []) {
      if (project.path_with_namespace?.startsWith(prefix)) {
        out.push({ id: project.id, gitlab_id: Number(project.gitlab_id) });
      }
    }
    if ((data ?? []).length < 500) break;
  }
  return out;
}
async function saveCursor(
  cursorId: string | null, projectId: string | null, syncType: "catalog" | "reconcile" | "label_events",
  cursor: Record<string, unknown>, complete = false,
): Promise<string> {
  const now = new Date().toISOString();
  const row = { integration_id: INTEGRATION_ID, project_id: projectId, sync_type: syncType,
    cursor, updated_at: now, last_successful_at: complete ? now : null };
  if (cursorId) {
    const { error } = await db.from("sync_cursors_gitlab").update(row).eq("id", cursorId);
    check(error);
    return cursorId;
  }
  const { data, error } = await db.from("sync_cursors_gitlab").insert(row).select("id").single();
  check(error);
  return data!.id;
}

/**
 * Completa os catálogos da integração para todos os projetos habilitados.
 * POST {}. Cursor por projeto em sync_cursors_gitlab(sync_type='catalog', project_id).
 * Não interfere no cursor global 'catalog' usado na importação de projetos.
 */
const MAX_PAGES_PER_REQUEST = 10;
type CatalogProgress = { phase: "labels" | "milestones" | "done"; page: number; complete: boolean };

async function groupsLookup(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let offset = 0;; offset += 500) {
    const { data, error } = await db.from("groups_gitlab").select("id,gitlab_id")
      .eq("integration_id", INTEGRATION_ID).range(offset, offset + 499);
    check(error);
    for (const g of data ?? []) out.set(Number(g.gitlab_id), g.id);
    if ((data ?? []).length < 500) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const started = Date.now();
  try {
    await ensureIntegration();
    const projects = await allProjects();
    const groupMap = await groupsLookup();
    if (!projects.length) throw new Error("Importe os projetos antes de executar esta função");
    let apiPages = 0;
    let labelsImported = 0;
    let milestonesImported = 0;
    const completedProjects: number[] = [];
    let currentProject: number | null = null;
    for (const project of projects) {
      if (apiPages >= MAX_PAGES_PER_REQUEST || Date.now() - started > MAX_DURATION_MS) break;
      const { data: saved, error: cursorError } = await db.from("sync_cursors_gitlab")
        .select("id,cursor").eq("integration_id", INTEGRATION_ID)
        .eq("sync_type", "catalog").eq("project_id", project.id).maybeSingle();
      check(cursorError);
      let cursorId: string | null = saved?.id ?? null;
      let progress: CatalogProgress = (saved?.cursor as CatalogProgress | null) ??
        { phase: "labels", page: 1, complete: false };
      if (progress.complete) continue;
      currentProject = project.gitlab_id;
      while (apiPages < MAX_PAGES_PER_REQUEST && Date.now() - started < MAX_DURATION_MS) {
        const phase = progress.phase;
        const path = phase === "labels"
          ? `/projects/${project.gitlab_id}/labels?include_ancestor_groups=true&per_page=${PER_PAGE}&page=${progress.page}`
          : `/projects/${project.gitlab_id}/milestones?include_ancestors=true&per_page=${PER_PAGE}&page=${progress.page}`;
        const { items, next } = await getPage(path);
        const now = new Date().toISOString();
        if (phase === "labels") {
          const rows = items.filter((l) => l?.id != null).map((l) => ({
            integration_id: INTEGRATION_ID, gitlab_id: l.id, name: l.name,
            color: l.color ?? null, description: l.description ?? null, synced_at: now,
          }));
          if (rows.length) {
            const { error } = await db.from("labels_gitlab")
              .upsert(rows, { onConflict: "integration_id,gitlab_id" });
            check(error);
          }
          labelsImported += rows.length;
        } else {
          const rows = items.filter((m) => m?.id != null).map((m) => ({
            integration_id: INTEGRATION_ID, gitlab_id: m.id,
            project_id: m.project_id != null ? project.id : null,
            group_id: m.group_id != null ? groupMap.get(Number(m.group_id)) ?? null : null,
            title: m.title, state: m.state ?? null,
            start_date: m.start_date ?? null, due_date: m.due_date ?? null, synced_at: now,
          }));
          if (rows.length) {
            const { error } = await db.from("milestones_gitlab")
              .upsert(rows, { onConflict: "integration_id,gitlab_id" });
            check(error);
          }
          milestonesImported += rows.length;
        }
        apiPages++;
        if (next) {
          progress = { phase, page: next, complete: false };
        } else if (phase === "labels") {
          progress = { phase: "milestones", page: 1, complete: false };
        } else {
          progress = { phase: "done", page: 1, complete: true };
        }
        cursorId = await saveCursor(cursorId, project.id, "catalog", progress, progress.complete);
        if (progress.complete) {
          completedProjects.push(project.gitlab_id);
          break;
        }
      }
    }
    const { count, error: countError } = await db.from("sync_cursors_gitlab")
      .select("id", { count: "exact", head: true }).eq("integration_id", INTEGRATION_ID)
      .eq("sync_type", "catalog").not("project_id", "is", null)
      .contains("cursor", { complete: true });
    check(countError);
    const complete = (count ?? 0) >= projects.length;
    return json({ integration_id: INTEGRATION_ID, group_id: GROUP_ID,
      project_count: projects.length, projects_completed_this_request: completedProjects,
      labels_imported: labelsImported, milestones_imported: milestonesImported,
      api_pages_processed: apiPages, current_project_gitlab_id: currentProject,
      complete, resume_required: !complete, duration_ms: Date.now() - started });
  } catch (error) {
    console.error("gitlab-import-catalog-details", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
