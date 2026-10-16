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

const BATCH_SIZE = 20;
const GITLAB_EVENTS_PER_PAGE = 100;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return success({});
  }

  let syncStarted = false;

  try {
    await startSync("gitlab_events");
    syncStarted = true;

    console.log("Iniciando sincronização de eventos...");

    const { data: issuesToProcess, error } = await supabase
      .from("gitlab_issue_label_sync_control")
      .select("id, project_id, issue_iid")
      .eq("synced", false)
      .order("id")
      .limit(BATCH_SIZE);

    if (error) {
      throw error;
    }

    if (!issuesToProcess || issuesToProcess.length === 0) {
      await finishSyncSuccess("gitlab_events", {
        progress: 0,
        total: 0,
        message: "Nenhuma issue pendente para sincronização",
      });

      syncStarted = false;

      return success({
        message: "Nenhuma issue pendente para sincronização",
      });
    }

    let processedIssues = 0;
    let processedEvents = 0;
    let ignoredEvents = 0;
    let errors = 0;

    for (const control of issuesToProcess) {
      try {
        console.log(
          `Processando projeto ${control.project_id} | issue ${control.issue_iid}`,
        );

        const { data: issue } = await supabase
          .from("gitlab_issues")
          .select("project_id, iid, group_id")
          .eq("project_id", control.project_id)
          .eq("iid", control.issue_iid)
          .single();

        if (!issue) {
          console.error(
            `Issue não encontrada no banco: projeto ${control.project_id} | issue ${control.issue_iid}`,
          );

          errors++;
          continue;
        }

        /**
         * Busca todos os eventos de labels da issue através de paginação.
         *
         * O GitLab retorna no máximo 100 registros por página.
         * O header `x-next-page` informa a próxima página disponível.
         */
        const allEvents: any[] = [];

        let page = 1;

        while (true) {
          const url =
            `${GITLAB_URL}/api/v4/projects/${issue.project_id}/issues/${issue.iid}/resource_label_events` +
            `?per_page=${GITLAB_EVENTS_PER_PAGE}&page=${page}`;

          console.log(
            `Buscando eventos: projeto ${issue.project_id} | issue ${issue.iid} | página ${page}`,
          );

          const response = await fetch(url, {
            headers: {
              "PRIVATE-TOKEN": GITLAB_TOKEN,
            },
          });

          if (!response.ok) {
            const errorText = await response.text();

            console.error(
              `Erro GitLab issue ${issue.iid} | página ${page}`,
              errorText,
            );

            errors++;
            break;
          }

          const events = await response.json();

          if (!Array.isArray(events)) {
            console.error(
              `Resposta inválida para issue ${issue.iid} | página ${page}`,
              events,
            );

            errors++;
            break;
          }

          allEvents.push(...events);

          const nextPageHeader = response.headers.get("x-next-page");
          const nextPage = nextPageHeader
            ? Number.parseInt(nextPageHeader, 10)
            : NaN;

          console.log(
            `Issue ${issue.iid} | página ${page} | eventos recebidos: ${events.length} | próxima página: ${
              Number.isFinite(nextPage) ? nextPage : "não"
            }`,
          );

          if (
            !Number.isFinite(nextPage) ||
            nextPage <= page ||
            events.length === 0
          ) {
            break;
          }

          page = nextPage;
        }

        console.log(
          `Issue ${issue.iid}: ${allEvents.length} eventos encontrados no GitLab.`,
        );

        /**
         * Remove possíveis duplicidades retornadas entre páginas.
         *
         * O ID do evento do GitLab é a chave única utilizada no banco
         * (`id_events`), portanto ele é a referência correta para deduplicação.
         */
        const uniqueEvents = Array.from(
          new Map(
            allEvents
              .filter((event: any) => event?.id != null)
              .map((event: any) => [String(event.id), event]),
          ).values(),
        );

        const rows = uniqueEvents
          .filter((event: any) => {
            if (!event.user) {
              console.warn(
                `Evento ${event.id} ignorado (sem usuário) - Issue ${issue.iid}`,
              );
              ignoredEvents++;
              return false;
            }

            if (!event.label) {
              console.warn(
                `Evento ${event.id} ignorado (sem label) - Issue ${issue.iid}`,
              );
              ignoredEvents++;
              return false;
            }

            if (!event.resource_id) {
              console.warn(
                `Evento ${event.id} ignorado (sem resource_id) - Issue ${issue.iid}`,
              );
              ignoredEvents++;
              return false;
            }

            if (!event.created_at) {
              console.warn(
                `Evento ${event.id} ignorado (sem created_at) - Issue ${issue.iid}`,
              );
              ignoredEvents++;
              return false;
            }

            if (!event.action) {
              console.warn(
                `Evento ${event.id} ignorado (sem action) - Issue ${issue.iid}`,
              );
              ignoredEvents++;
              return false;
            }

            return true;
          })
          .map((event: any) => ({
            id_events: event.id,

            project_id: issue.project_id,
            group_id: issue.group_id,
            issue_iid: issue.iid,

            user_name: event.user.name,

            created_at: event.created_at,

            resource_type: event.resource_type,
            resource_id: event.resource_id,

            id_label: event.label.id,
            name_label: event.label.name,

            action: event.action,

            last_sync_at: new Date().toISOString(),
          }));

        if (rows.length > 0) {
          const { error: upsertError } = await supabase
            .from("gitlab_issue_label_events")
            .upsert(rows, {
              onConflict: "id_events",
            });

          if (upsertError) {
            console.error(
              `Erro ao salvar eventos da issue ${issue.iid}`,
              upsertError,
            );

            errors++;
            continue;
          }

          processedEvents += rows.length;
        } else {
          console.log(
            `Issue ${issue.iid} não possui eventos válidos para sincronização.`,
          );
        }

        /**
         * Só marca a issue como sincronizada depois que todas as páginas
         * foram processadas e os eventos foram persistidos com sucesso.
         */
        await supabase
          .from("gitlab_issue_label_sync_control")
          .update({
            synced: true,
            synced_at: new Date().toISOString(),
          })
          .eq("id", control.id);

        processedIssues++;
      } catch (issueError) {
        console.error(
          `Erro na issue ${control.issue_iid}`,
          issueError,
        );

        errors++;
      }
    }

    const progressTotal = issuesToProcess.length;
    const progressMessage =
      `${progressTotal} de ${progressTotal} registros processados`;

    await updateProgress(
      "gitlab_events",
      progressTotal,
      progressTotal,
    );

    const { error: progressMessageError } = await supabase
      .from("integration_sync_control")
      .update({ message: progressMessage })
      .eq("process_name", "gitlab_events");

    if (progressMessageError) {
      throw progressMessageError;
    }

    await finishSyncSuccess("gitlab_events", {
      progress: progressTotal,
      total: progressTotal,
      message:
        `Sincronização concluída: ${processedIssues} issues processadas e ${processedEvents} eventos sincronizados.`,
    });

    syncStarted = false;

    return success({
      batch_size: BATCH_SIZE,
      processed_issues: processedIssues,
      processed_events: processedEvents,
      ignored_events: ignoredEvents,
      errors,
    });
  } catch (error) {
    console.error("Erro geral:", error);

    if (syncStarted) {
      try {
        await finishSyncError("gitlab_events", error);
      } catch (syncControlError) {
        console.error(
          "Erro ao registrar falha da sincronização:",
          syncControlError,
        );
      }
    }

    return internalError(error);
  }
});