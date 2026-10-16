import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const GITLAB_URL = Deno.env.get("GITLAB_URL")!;
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN")!;

const BATCH_SIZE = 500;

Deno.serve(async () => {
  try {

    console.log("Iniciando sincronização de eventos...");

    const { data: issuesToProcess, error } = await supabase
      .from("gitlab_issue_label_sync_control")
      .select("id, project_id, issue_iid")
      .eq("synced", false)
      .neq("project_id", 169)
      .order("id")
      .limit(BATCH_SIZE);

    if (error) {
      return Response.json(
        {
          success: false,
          step: "buscar_lote",
          error
        },
        {
          status: 500
        }
      );
    }

    if (!issuesToProcess || issuesToProcess.length === 0) {
      return Response.json({
        success: true,
        message: "Nenhuma issue pendente para sincronização"
      });
    }

    let processedIssues = 0;
    let processedEvents = 0;
    let errors = 0;
    let skippedProjects = 0;

    for (const control of issuesToProcess) {

      // Proteção extra
      if (control.project_id === 169) {

        console.log(
          `Projeto ${control.project_id} ignorado | issue ${control.issue_iid}`
        );

        skippedProjects++;

        await supabase
          .from("gitlab_issue_label_sync_control")
          .update({
            synced: true,
            synced_at: new Date().toISOString()
          })
          .eq("id", control.id);

        continue;
      }

      try {

        console.log(
          `Processando projeto ${control.project_id} | issue ${control.issue_iid}`
        );

        const { data: issue } = await supabase
          .from("gitlab_issues")
          .select("project_id, iid, group_id")
          .eq("project_id", control.project_id)
          .eq("iid", control.issue_iid)
          .single();

        if (!issue) {
          errors++;
          continue;
        }

        const response = await fetch(
          `${GITLAB_URL}/api/v4/projects/${issue.project_id}/issues/${issue.iid}/resource_label_events`,
          {
            headers: {
              "PRIVATE-TOKEN": GITLAB_TOKEN,
            },
          }
        );

        if (!response.ok) {

          const errorText = await response.text();

          console.error(
            `Erro GitLab issue ${issue.iid}`,
            errorText
          );

          errors++;
          continue;
        }

        const events = await response.json();

        if (!Array.isArray(events)) {
          console.error(
            `Resposta inválida para issue ${issue.iid}`,
            events
          );

          errors++;
          continue;
        }

        if (events.length > 0) {

          const rows = events.map((event: any) => ({
            id_events: event.id,

            project_id: issue.project_id,
            group_id: issue.group_id,
            issue_iid: issue.iid,

            user_name: event.user?.name ?? null,

            created_at: event.created_at,

            resource_type: event.resource_type,
            resource_id: event.resource_id,

            id_label: event.label?.id ?? null,
            name_label: event.label?.name ?? null,

            action: event.action,

            last_sync_at: new Date().toISOString()
          }));

          const { error: upsertError } = await supabase
            .from("gitlab_issue_label_events")
            .upsert(rows, {
              onConflict: "id_events"
            });

          if (upsertError) {
            console.error(
              `Erro ao salvar eventos da issue ${issue.iid}`,
              upsertError
            );

            errors++;
            continue;
          }

          processedEvents += rows.length;
        }

        await supabase
          .from("gitlab_issue_label_sync_control")
          .update({
            synced: true,
            synced_at: new Date().toISOString()
          })
          .eq("id", control.id);

        processedIssues++;

      } catch (issueError) {

        console.error(
          `Erro na issue ${control.issue_iid}`,
          issueError
        );

        errors++;
      }
    }

    return Response.json({
      success: true,
      batch_size: BATCH_SIZE,
      processed_issues: processedIssues,
      processed_events: processedEvents,
      skipped_project_169: skippedProjects,
      errors
    });

  } catch (error) {

    console.error("Erro geral:", error);

    return Response.json(
      {
        success: false,
        error: String(error)
      },
      {
        status: 500
      }
    );
  }
});