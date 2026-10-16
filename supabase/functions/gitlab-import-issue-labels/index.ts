/**
 * Flow Analytics | GitLab - Labels ATUAIS das Issues
 *
 * Corrige a ambiguidade entre Labels com nomes iguais em grupos/projetos:
 * usa a API GraphQL para buscar os IDs reais das Labels de cada Issue.
 *
 * POST {} - integração 1cfb42c7-3676-4045-b63c-2ad876812575, grupo do secret.
 * Cada chamada processa até 15 Issues e continua pelo cursor salvo.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const INTEGRATION_ID = "1cfb42c7-3676-4045-b63c-2ad876812575";
const GITLAB_URL = (Deno.env.get("GITLAB_URL") ?? "").trim().replace(/\/+$/, "");
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN") ?? "";
const GROUP_ID = Number(Deno.env.get("GITLAB_GROUP_ID"));
const MAX_ISSUES_PER_REQUEST = 1500;
const MAX_DURATION_MS = 55_000;
const GITLAB_TIMEOUT_MS = 18_000;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type DbIssue = {
  id: string;
  iid: number;
  gitlab_id: number;
  project_id: string;
};
type ProjectInfo = { id: string; fullPath: string };
type GitLabLabel = {
  gitlabId: number;
  title: string;
  color: string | null;
  description: string | null;
};
type Progress = {
  task: "current_labels";
  last_issue_id: string | null;
  complete: boolean;
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
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

async function ensureIntegration(): Promise<string> {
  if (!/^https?:\/\//i.test(GITLAB_URL) || !GITLAB_TOKEN ||
    !Number.isSafeInteger(GROUP_ID) || GROUP_ID <= 0) {
    throw new Error("Secrets GITLAB_URL, GITLAB_TOKEN ou GITLAB_GROUP_ID inválidos");
  }

  const { data: integration, error } = await db.from("integrations_gitlab")
    .select("id,base_url,is_active").eq("id", INTEGRATION_ID).single();
  check(error);
  if (!integration?.is_active ||
    integration.base_url?.trim().replace(/\/+$/, "") !== GITLAB_URL) {
    throw new Error("Integração inativa ou URL diferente do secret GITLAB_URL");
  }

  const { data: root, error: groupError } = await db.from("groups_gitlab")
    .select("full_path").eq("integration_id", INTEGRATION_ID)
    .eq("gitlab_id", GROUP_ID).single();
  check(groupError);
  if (!root?.full_path) throw new Error(`Grupo ${GROUP_ID} não cadastrado em groups_gitlab`);
  return root.full_path;
}

async function allProjects(rootPath: string): Promise<Map<string, ProjectInfo>> {
  const projects = new Map<string, ProjectInfo>();
  const prefix = `${rootPath}/`;
  for (let offset = 0;; offset += 500) {
    const { data, error } = await db.from("projects_gitlab")
      .select("id,path_with_namespace")
      .eq("integration_id", INTEGRATION_ID)
      .eq("import_enabled", true)
      .order("gitlab_id", { ascending: true })
      .range(offset, offset + 499);
    check(error);
    for (const project of data ?? []) {
      if (project.path_with_namespace?.startsWith(prefix)) {
        projects.set(project.id, { id: project.id, fullPath: project.path_with_namespace });
      }
    }
    if ((data ?? []).length < 500) break;
  }
  return projects;
}

// Os nomes podem ser repetidos. O ID retornado neste endpoint pertence à
// Label realmente associada à Issue, e não apenas ao catálogo do projeto.
async function getIssueLabels(issue: DbIssue, projectPath: string): Promise<GitLabLabel[]> {
  const query = `
    query IssueLabels($fullPath: ID!, $iid: String!, $after: String) {
      project(fullPath: $fullPath) {
        issue(iid: $iid) {
          labels(first: 100, after: $after) {
            nodes { id title color description }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;

  const results = new Map<number, GitLabLabel>();
  let after: string | null = null;
  for (let page = 0; page < 30; page++) {
    const response = await fetch(`${GITLAB_URL}/api/graphql`, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": GITLAB_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { fullPath: projectPath, iid: String(issue.iid), after },
      }),
      signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitLab GraphQL HTTP ${response.status} para ${projectPath}#${issue.iid}: ${detail}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(`GitLab GraphQL ${projectPath}#${issue.iid}: ${payload.errors.map((e: { message?: string }) => e.message ?? "erro").join("; ")}`);
    }
    const connection = payload.data?.project?.issue?.labels;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new Error(`GraphQL não retornou Labels para ${projectPath}#${issue.iid}. Verifique a versão/permissões do GitLab.`);
    }

    for (const label of connection.nodes) {
      if (!label) continue;
      const match = typeof label.id === "string" ? label.id.match(/\/(\d+)$/) : null;
      const gitlabId = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(gitlabId) || !label.title) {
        throw new Error(`Label GraphQL inválida em ${projectPath}#${issue.iid}: ${JSON.stringify(label)}`);
      }
      results.set(gitlabId, {
        gitlabId,
        title: label.title,
        color: label.color ?? null,
        description: label.description ?? null,
      });
    }

    if (!connection.pageInfo.hasNextPage) return [...results.values()];
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) {
      throw new Error(`Paginação GraphQL inconsistente em ${projectPath}#${issue.iid}`);
    }
    after = connection.pageInfo.endCursor;
  }
  throw new Error(`Limite de páginas GraphQL atingido para ${projectPath}#${issue.iid}`);
}

async function persistCurrentLabels(issue: DbIssue, labels: GitLabLabel[]): Promise<number> {
  const externalIds = [...new Set(labels.map((l) => l.gitlabId))];
  const now = new Date().toISOString();
  if (labels.length > 0) {
    const rows = labels.map((l) => ({
      integration_id: INTEGRATION_ID,
      gitlab_id: l.gitlabId,
      name: l.title,
      color: l.color,
      description: l.description,
      synced_at: now,
    }));
    const { error } = await db.from("labels_gitlab")
      .upsert(rows, { onConflict: "integration_id,gitlab_id" });
    check(error);
  }

  const { data: dbLabels, error: labelError } = externalIds.length > 0
    ? await db.from("labels_gitlab").select("id,gitlab_id")
      .eq("integration_id", INTEGRATION_ID).in("gitlab_id", externalIds)
    : { data: [], error: null };
  check(labelError);
  if ((dbLabels ?? []).length !== externalIds.length) {
    throw new Error(`Falha ao encontrar Labels persistidas para a Issue ${issue.gitlab_id}`);
  }

  const desired = (dbLabels ?? []).map((l) => ({ issue_id: issue.id, label_id: l.id }));
  if (desired.length) {
    const { error } = await db.from("issue_labels_gitlab")
      .upsert(desired, { onConflict: "issue_id,label_id" });
    check(error);
  }

  const desiredIds = new Set(desired.map((l) => l.label_id));
  const { data: current, error: currentError } = await db.from("issue_labels_gitlab")
    .select("label_id").eq("issue_id", issue.id);
  check(currentError);
  const stale = (current ?? []).filter((l) => !desiredIds.has(l.label_id)).map((l) => l.label_id);
  if (stale.length) {
    const { error } = await db.from("issue_labels_gitlab")
      .delete().eq("issue_id", issue.id).in("label_id", stale);
    check(error);
  }

  const { error: markError } = await db.from("issues_gitlab")
    .update({ labels_synced_at: now }).eq("id", issue.id).eq("integration_id", INTEGRATION_ID);
  check(markError);
  return desired.length;
}

async function saveCursor(id: string | null, cursor: Progress, complete = false): Promise<string> {
  const now = new Date().toISOString();
  if (id) {
    const { error } = await db.from("sync_cursors_gitlab")
      .update({ cursor, updated_at: now, last_successful_at: complete ? now : null })
      .eq("id", id).eq("integration_id", INTEGRATION_ID);
    check(error);
    return id;
  }
  const { data, error } = await db.from("sync_cursors_gitlab")
    .insert({ integration_id: INTEGRATION_ID, project_id: null, sync_type: "current_labels",
      cursor, updated_at: now, last_successful_at: complete ? now : null })
    .select("id").single();
  check(error);
  return data!.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const started = Date.now();
  try {
    const root = await ensureIntegration();
    const projects = await allProjects(root);
    if (projects.size === 0) throw new Error(`Nenhum projeto do grupo ${GROUP_ID} disponível para importação`);

    const { data: saved, error: cursorError } = await db.from("sync_cursors_gitlab")
      .select("id,cursor").eq("integration_id", INTEGRATION_ID)
      .eq("sync_type", "current_labels").is("project_id", null).maybeSingle();
    check(cursorError);
    const old = saved?.cursor as Partial<Progress> | null;
    if (old && old.task !== "current_labels") {
      throw new Error("O cursor global 'reconcile' pertence a outra rotina; importação não iniciada");
    }
    let progress: Progress = {
      task: "current_labels",
      last_issue_id: old?.last_issue_id ?? null,
      complete: old?.complete === true,
    };
    let cursorId: string | null = saved?.id ?? null;
    if (progress.complete) return json({ complete: true, issues_processed: 0, message: "Importação concluída anteriormente" });

    let processed = 0;
    let written = 0;
    while (processed < MAX_ISSUES_PER_REQUEST && Date.now() - started < MAX_DURATION_MS) {
      let query = db.from("issues_gitlab")
        .select("id,iid,gitlab_id,project_id")
        .eq("integration_id", INTEGRATION_ID)
        .order("id", { ascending: true }).limit(1);
      if (progress.last_issue_id) query = query.gt("id", progress.last_issue_id);
      const { data, error } = await query;
      check(error);
      const issue = (data?.[0] ?? null) as DbIssue | null;
      if (!issue) {
        progress = { ...progress, complete: true };
        cursorId = await saveCursor(cursorId, progress, true);
        break;
      }
      const project = projects.get(issue.project_id);
      if (!project) {
        throw new Error(`Issue ${issue.gitlab_id} aponta para projeto fora do grupo ${GROUP_ID} ou desabilitado`);
      }

      const labels = await getIssueLabels(issue, project.fullPath);
      written += await persistCurrentLabels(issue, labels);
      processed++;

      progress = { task: "current_labels", last_issue_id: issue.id, complete: false };
      cursorId = await saveCursor(cursorId, progress);
      console.log(`Issue ${project.fullPath}#${issue.iid}: ${labels.length} Labels atuais sincronizadas`);
    }

    return json({
      integration_id: INTEGRATION_ID,
      group_id: GROUP_ID,
      issues_processed: processed,
      current_label_relations_written: written,
      complete: progress.complete,
      resume_required: !progress.complete,
      next: progress,
      duration_ms: Date.now() - started,
      source: "GitLab GraphQL / issue.labels (IDs reais)",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("gitlab-import-issue-labels", error);
    return json({ error: message }, 500);
  }
});
