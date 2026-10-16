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

    while (true) {
      const response = await fetch(
        `${GITLAB_URL}/api/v4/groups/${GROUP_ID}/issues?created_after=2026-01-01T00:00:00Z&per_page=1000&page=${page}`,
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

        last_sync_at: new Date().toISOString(),
      }));

      const { error } = await supabase
        .from("gitlab_issues")
        .upsert(rows, {
          onConflict: "gitlab_issue_id",
        });

      if (error) {
        throw error;
      }

      totalImported += rows.length;
      page++;
    }

    return new Response(
      JSON.stringify({
        success: true,
        imported: totalImported,
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
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