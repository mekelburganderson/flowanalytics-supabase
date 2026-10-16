import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const GITLAB_URL = Deno.env.get("GITLAB_URL")!;
const GITLAB_TOKEN = Deno.env.get("GITLAB_TOKEN")!;

const BATCH_SIZE = 80;

Deno.serve(async () => {
  try {

    console.log("Iniciando sincronização de labels por projeto");

    const { data: projects, error } = await supabase
      .from("gitlab_projects")
      .select("project_id")
      .eq("is_active", true)
      .neq("project_id", 169)
      .order("project_id")
      .limit(BATCH_SIZE);

    if (error) {
      throw error;
    }

    if (!projects || projects.length === 0) {

      return Response.json({
        success: true,
        projects_processed: 0,
        labels_saved: 0
      });
    }

    let processedProjects = 0;
    let savedLabels = 0;
    let errors = 0;

    for (const project of projects) {

      try {

        console.log(
          `Buscando labels do projeto ${project.project_id}`
        );

        const response = await fetch(
          `${GITLAB_URL}/api/v4/projects/${project.project_id}/labels?per_page=100`,
          {
            headers: {
              "PRIVATE-TOKEN": GITLAB_TOKEN,
            },
          }
        );

        if (!response.ok) {

          const errorText = await response.text();

          console.error(
            `Erro projeto ${project.project_id}`,
            errorText
          );

          errors++;
          continue;
        }

        const labels = await response.json();

        if (!Array.isArray(labels)) {

          console.error(
            `Resposta inválida projeto ${project.project_id}`
          );

          errors++;
          continue;
        }

        if (labels.length === 0) {

          processedProjects++;

          console.log(
            `Projeto ${project.project_id}: nenhuma label encontrada`
          );

          continue;
        }

        const now = new Date().toISOString();

        const rows = labels.map((label: any) => ({
          id_label: label.id,

          project_id: project.project_id,

          name: label.name,
          description: label.description,

          color: label.color,
          text_color: label.text_color,

          is_active: true,

          updated_at: now,
          last_sync_at: now
        }));

        const { error: upsertError } = await supabase
          .from("gitlab_labels")
          .upsert(rows, {
            onConflict: "id_label"
          });

        if (upsertError) {

          console.error(
            `Erro ao salvar labels do projeto ${project.project_id}`,
            upsertError
          );

          errors++;
          continue;
        }

        processedProjects++;
        savedLabels += rows.length;

        console.log(
          `Projeto ${project.project_id}: ${rows.length} labels sincronizadas`
        );

      } catch (projectError) {

        console.error(
          `Erro projeto ${project.project_id}`,
          projectError
        );

        errors++;
      }
    }

    return Response.json({
      success: true,
      projects_processed: processedProjects,
      labels_saved: savedLabels,
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