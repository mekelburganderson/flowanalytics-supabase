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

    console.log("Iniciando sincronização de projetos");

    let page = 1;
    let totalProjects = 0;

    while (true) {

      const response = await fetch(
        `${GITLAB_URL}/api/v4/groups/${GROUP_ID}/projects?per_page=100&page=${page}&include_subgroups=true`,
        {
          headers: {
            "PRIVATE-TOKEN": GITLAB_TOKEN,
          },
        }
      );

      if (!response.ok) {

        const errorText = await response.text();

        return Response.json(
          {
            success: false,
            step: "buscar_projetos_gitlab",
            page,
            error: errorText
          },
          {
            status: 500
          }
        );
      }

      const projects = await response.json();

      if (!Array.isArray(projects) || projects.length === 0) {
        break;
      }

      const rows = projects.map((project: any) => ({
        project_id: project.id,

        group_id: Number(GROUP_ID),

        name: project.name,
        path: project.path,
        path_with_namespace: project.path_with_namespace,

        description: project.description,

        web_url: project.web_url,

        default_branch: project.default_branch,

        visibility: project.visibility,

        archived: project.archived ?? false,

        created_at: project.created_at,
        last_activity_at: project.last_activity_at,

        is_active: !project.archived,

        updated_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString()
      }));

      const { error } = await supabase
        .from("gitlab_projects")
        .upsert(rows, {
          onConflict: "project_id"
        });

      if (error) {

        return Response.json(
          {
            success: false,
            step: "upsert_projetos",
            page,
            error
          },
          {
            status: 500
          }
        );
      }

      totalProjects += rows.length;

      console.log(
        `Página ${page} processada. Projetos: ${rows.length}`
      );

      page++;
    }

    return Response.json({
      success: true,
      projects_imported: totalProjects
    });

  } catch (error) {

    console.error(error);

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