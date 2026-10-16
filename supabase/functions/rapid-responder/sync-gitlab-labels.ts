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

    console.log("Iniciando sincronização de labels");

    const response = await fetch(
      `${GITLAB_URL}/api/v4/groups/${GROUP_ID}/labels?per_page=100`,
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
          step: "buscar_labels_gitlab",
          error: errorText
        },
        {
          status: 500
        }
      );
    }

    const labels = await response.json();

    if (!Array.isArray(labels)) {

      return Response.json(
        {
          success: false,
          step: "validar_retorno",
          error: "Resposta inválida do GitLab"
        },
        {
          status: 500
        }
      );
    }

    const rows = labels.map((label: any) => ({
      id_label: label.id,

      group_id: Number(GROUP_ID),

      name: label.name,
      description: label.description,

      color: label.color,
      text_color: label.text_color,

      is_active: true,

      last_sync_at: new Date().toISOString(),

      updated_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from("gitlab_labels")
      .upsert(rows, {
        onConflict: "id_label"
      });

    if (error) {

      return Response.json(
        {
          success: false,
          step: "upsert_labels",
          error
        },
        {
          status: 500
        }
      );
    }

    return Response.json({
      success: true,
      labels_found: labels.length,
      labels_saved: rows.length
    });

  } catch (error) {

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