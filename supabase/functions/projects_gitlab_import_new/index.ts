import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const INTEGRATION_ID = "1cfb42c7-3676-4045-b63c-2ad876812575";
const GITLAB_URL = (Deno.env.get("GITLAB_URL") ?? "").trim().replace(/\/+$/, "");
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN") ?? "";
const GROUP_ID = Number(Deno.env.get("GITLAB_GROUP_ID"));
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function verify(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}
async function gitlab(path: string) {
  const result = await fetch(`${GITLAB_URL}/api/v4${path}`, {
    headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, Accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
  if (!result.ok) throw new Error(`GitLab HTTP ${result.status}: ${(await result.text()).slice(0, 350)}`);
  return result;
}
async function saveCursor(cursorId: string | null, cursor: Record<string, unknown>, complete: boolean) {
  const row = {
    integration_id: INTEGRATION_ID, project_id: null, sync_type: "catalog",
    cursor, updated_at: new Date().toISOString(),
    last_successful_at: complete ? new Date().toISOString() : null,
  };
  if (cursorId) {
    const { error } = await db.from("sync_cursors_gitlab").update(row).eq("id", cursorId);
    verify(error);
  } else {
    const { error } = await db.from("sync_cursors_gitlab").insert(row);
    verify(error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    if (!/^https?:\/\//i.test(GITLAB_URL) || !GITLAB_TOKEN || !Number.isSafeInteger(GROUP_ID) || GROUP_ID <= 0) {
      throw new Error("Configure GITLAB_URL, GITLAB_TOKEN e GITLAB_GROUP_ID nos secrets");
    }
    const { data: integration, error: integrationError } = await db
      .from("integrations_gitlab").select("id,base_url,is_active")
      .eq("id", INTEGRATION_ID).single();
    verify(integrationError);
    if (!integration?.is_active || integration.base_url.trim().replace(/\/+$/, "") !== GITLAB_URL) {
      return json({ error: "Integração inativa ou URL divergente" }, 400);
    }

    const { data: saved, error: cursorError } = await db.from("sync_cursors_gitlab")
      .select("id,cursor").eq("integration_id", INTEGRATION_ID)
      .eq("sync_type", "catalog").is("project_id", null).maybeSingle();
    verify(cursorError);
    if (saved?.cursor?.complete === true) {
      return json({ complete: true, imported_projects: 0, message: "Catálogo já importado. Consulte o cursor para reiniciar uma nova carga." });
    }
    const page = Number(saved?.cursor?.page ?? 1);
    if (!Number.isInteger(page) || page < 1) throw new Error("Cursor de catálogo inválido");
    const root = await (await gitlab(`/groups/${GROUP_ID}`)).json();
    const now = new Date().toISOString();
    const { error: rootError } = await db.from("groups_gitlab").upsert({
      integration_id: INTEGRATION_ID, gitlab_id: root.id, name: root.name,
      full_path: root.full_path, web_url: root.web_url, raw_payload: root, synced_at: now,
    }, { onConflict: "integration_id,gitlab_id" });
    verify(rootError);

    const response = await gitlab(`/groups/${GROUP_ID}/projects?include_subgroups=true&with_shared=false&per_page=100&page=${page}`);
    const projects: any[] = await response.json();
    const namespaces = new Map<number, any>();
    for (const project of projects) {
      if (project.namespace?.kind === "group" && project.namespace.id !== root.id) {
        namespaces.set(project.namespace.id, project.namespace);
      }
    }
    for (const namespace of namespaces.values()) {
      const full = await (await gitlab(`/groups/${namespace.id}`)).json();
      const { error } = await db.from("groups_gitlab").upsert({
        integration_id: INTEGRATION_ID, gitlab_id: full.id, name: full.name,
        full_path: full.full_path, web_url: full.web_url, raw_payload: full, synced_at: now,
      }, { onConflict: "integration_id,gitlab_id" });
      verify(error);
    }
    const groupIds = [...namespaces.keys(), root.id];
    const { data: groups, error: groupsError } = await db.from("groups_gitlab")
      .select("id,gitlab_id").eq("integration_id", INTEGRATION_ID).in("gitlab_id", groupIds);
    verify(groupsError);
    const groupMap = new Map((groups ?? []).map((g: any) => [Number(g.gitlab_id), g.id]));
    if (projects.length) {
      const rows = projects.map((p: any) => ({
        integration_id: INTEGRATION_ID, gitlab_id: p.id,
        group_id: groupMap.get(p.namespace?.id) ?? null,
        name: p.name, path_with_namespace: p.path_with_namespace,
        namespace_full_path: p.namespace?.full_path ?? null, web_url: p.web_url,
        archived: Boolean(p.archived), marked_for_deletion_on: p.marked_for_deletion_on ?? null,
        last_activity_at: p.last_activity_at ?? null, raw_payload: p, synced_at: now,
      }));
      const { error } = await db.from("projects_gitlab").upsert(rows, { onConflict: "integration_id,gitlab_id" });
      verify(error);
    }
    const nextPage = Number(response.headers.get("x-next-page") || 0) || null;
    await saveCursor(saved?.id ?? null, { page: nextPage ?? page, complete: !nextPage }, !nextPage);
    return json({ integration_id: INTEGRATION_ID, group_id: GROUP_ID, page,
      imported_projects: projects.length, next_page: nextPage, complete: !nextPage });
  } catch (e) {
    console.error("gitlab-import-projects", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
