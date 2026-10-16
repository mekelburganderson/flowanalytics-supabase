import { success, internalError } from "../_shared/responses.ts";
import {
  startSync,
  finishSyncError,
  finishSyncSuccess,
  updateProgress,
} from "../_shared/sync-control.ts";
import { supabase } from "../_shared/supabase.ts";

const GITLAB_URL = Deno.env.get("GITLAB_URL")!;
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN")!;
const GROUP_ID = Deno.env.get("GITLAB_GROUP_ID")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return success({});
  }

  let syncStarted = false;

  try {

    await startSync("gitlab_issues");
    syncStarted = true;

    let page = 1;
    let totalImported = 0;
    let totalQueued = 0;
    let totalIssues: number | null = null;
    let totalPages: number | null = null;
    const syncAt = new Date().toISOString();

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

      if (totalIssues === null) {
        const totalHeader = response.headers.get("x-total");
        if (totalHeader !== null) {
          const total = Number(totalHeader);
          totalIssues = Number.isFinite(total) ? total : null;
        }

        const pagesHeader = response.headers.get("x-total-pages");
        if (pagesHeader !== null) {
          const pages = Number(pagesHeader);
          totalPages = Number.isFinite(pages) ? pages : null;
        }
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

        last_sync_at: syncAt,
      }));

      const { error: issuesError } = await supabase
        .from("gitlab_issues")
        .upsert(rows, {
          onConflict: "gitlab_issue_id",
        });

      if (issuesError) {
        throw issuesError;
      }

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

      const progressTotal = totalIssues ?? totalImported;
      const progressMessage = totalPages
        ? `Página ${page} de ${totalPages}`
        : `${totalImported} de ${progressTotal} registros sincronizados`;

      await updateProgress("gitlab_issues", totalImported, progressTotal);

      const { error: progressMessageError } = await supabase
        .from("integration_sync_control")
        .update({ message: progressMessage })
        .eq("process_name", "gitlab_issues");

      if (progressMessageError) {
        throw progressMessageError;
      }

      console.log(
        `Página ${page}: ${rows.length} issues sincronizadas e ${syncRows.length} issues enviadas para fila`
      );

      page++;
    }

    const finalTotal = totalIssues ?? totalImported;

    await finishSyncSuccess("gitlab_issues", {
      progress: finalTotal,
      total: finalTotal,
      message: `Sincronização concluída: ${totalImported} issues importadas.`,
    });
    syncStarted = false;

    return success({
      imported: totalImported,
      queued: totalQueued,
    });

  } catch (error) {

    console.error(error);

    if (syncStarted) {
      try {
        await finishSyncError("gitlab_issues", error);
      } catch (syncControlError) {
        console.error("Erro ao registrar falha da sincronização:", syncControlError);
      }
    }

    return internalError(error);

  }

});