import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const GITLAB_URL = Deno.env.get("GITLAB_URL")!;
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN")!;
const GROUP_ID = Deno.env.get("GITLAB_GROUP_ID")!;

Deno.serve(async () => {
  try {
    let page = 1;
    let totalImported = 0;
    let totalQueued = 0;

    while (true) {
      const response = await fetch(
        `${GITLAB_URL}/api/v4/groups/${GROUP_ID}/issues?created_after=2025-01-01T00:00:00Z&created_before=2025-03-31T23:59:59Z&per_page=1000&page=${page}`,
        {
          headers: {
            "PRIVATE-TOKEN": GITLAB_TOKEN,
          },
        }
      );

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const issues = await response.json();

      if (issues.length === 0) {
        break;
      }

      const syncAt = new Date().toISOString();

      const rows = issues.map((issue: any) => ({
        gitlab_issue_id: issue.id,
        iid: issue.iid,
        project_id: issue.project_id,
        group_id: Number(GROUP_ID),

        title: issue.title,
        web_url: issue.web_url,
        state: issue.state,

        created_at: issue.created_at,
        updated_at: issue.updated_at,
        closed_at: issue.closed_at,

        author_name: issue.author?.name ?? null,
        author_gitlab_id: issue.author?.id ?? null,

        assignee_name: issue.assignees?.[0]?.name ?? null,
        assignee_gitlab_id: issue.assignees?.[0]?.id ?? null,

        closed_by_name: issue.closed_by?.name ?? null,
        closed_by_gitlab_id: issue.closed_by?.id ?? null,

        labels: issue.labels ?? [],

        milestone_title: issue.milestone?.title ?? null,

        last_sync_at: syncAt,
      }));

      // Sincroniza as issues
      const { error: issuesError } = await supabase
        .from("gitlab_issues")
        .upsert(rows, {
          onConflict: "gitlab_issue_id",
        });

      if (issuesError) {
        throw issuesError;
      }

      // Alimenta a fila de sincronização de eventos
      const syncRows = rows.map((issue) => ({
        project_id: issue.project_id,
        issue_iid: issue.iid,
        synced: false,
        synced_at: null,
      }));

      const { error: syncError } = await supabase
        .from("gitlab_issue_label_sync_control")
        .upsert(syncRows, {
          onConflict: "project_id,issue_iid",
          ignoreDuplicates: true,
        });

      if (syncError) {
        throw syncError;
      }

      totalImported += rows.length;
      totalQueued += syncRows.length;

      console.log(
        `Página ${page}: ${rows.length} issues sincronizadas e ${syncRows.length} issues enviadas para fila`
      );

      page++;
    }

    return new Response(
      JSON.stringify({
        success: true,
        imported: totalImported,
        queued: totalQueued,
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(error);

    return new Response(
      JSON.stringify({
        success: false,
        error: String(error),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
});