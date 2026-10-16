import { createClient } from "npm:@supabase/supabase-js@2.57.0";

/**
 * Flow Analytics | gitlab-sync-orchestrator
 * Uma requisição = no máximo um lote de uma Edge Function.
 * Entrada: POST sem body (body é ignorado).
 * Autorização:
 *  - Cron/serviço: x-orchestrator-secret;
 *  - cliente administrativo de serviço: Authorization: Bearer SERVICE_ROLE_KEY
 *    ou apikey: SERVICE_ROLE_KEY.
 * Sem credencial válida: HTTP 401 (nunca deixar público).
 * As funções importadoras já existentes mantêm seus próprios checkpoints.
 * NÃO desative autenticação das funções importadoras.
 */

const INTEGRATION_ID = "1cfb42c7-3676-4045-b63c-2ad876812575";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ORCHESTRATOR_SECRET = Deno.env.get("GITLAB_ORCHESTRATOR_SECRET") ?? "";

// Configure estes secrets se os nomes de deploy diferirem dos padrões abaixo.
const FUNCTIONS = {
  projects: Deno.env.get("ORCH_FN_PROJECTS") || "projects_gitlab_import_new",
  issues: Deno.env.get("ORCH_FN_ISSUES") || "issues_gitlab_new",
  catalog_details: Deno.env.get("ORCH_FN_CATALOG") || "gitlab-import-catalog-details",
  reconcile: Deno.env.get("ORCH_FN_RECONCILE") || "gitlab-reconcile-issues",
  current_labels: Deno.env.get("ORCH_FN_CURRENT_LABELS") || "gitlab-import-issue-labels",
  label_events: Deno.env.get("ORCH_FN_LABEL_EVENTS") || "gitlab-import-label-events",
} as const;

const LEASE_MS = 240_000;
const WORKER_TIMEOUT_MS = 95_000;
const CYCLE_INTERVAL_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const MIN_BACKOFF_MS = 5 * 60_000;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Phase = "projects" | "issues" | "catalog_details" | "reconcile" |
  "current_labels" | "label_events" | "idle";

type State = {
  integration_id: string;
  phase: Phase;
  cycle_number: number;
  known_project_ids: number[] | null;
  phase_entered_at: string;
  next_run_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  failure_count: number;
};

type CursorRecord = {
  id: string;
  cursor: Record<string, unknown> | null;
  updated_at: string;
};

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function check(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}
function iso(): string { return new Date().toISOString(); }
function nextPhase(phase: Phase): Phase {
  switch (phase) {
    case "projects": return "issues";
    case "issues": return "catalog_details";
    case "catalog_details": return "reconcile";
    case "reconcile": return "current_labels";
    case "current_labels": return "label_events";
    case "label_events": return "idle";
    default: return "projects";
  }
}
function summary(payload: Record<string, unknown>): Record<string, unknown> {
  const fields = ["complete", "resume_required", "page", "next_page", "pages_processed",
    "issues_imported", "issues_processed", "issues_new", "issues_modified",
    "labels_imported", "milestones_imported", "events_processed", "issues_completed",
    "project_count", "imported_projects", "duration_ms"];
  const out: Record<string, unknown> = {};
  for (const key of fields) if (key in payload) out[key] = payload[key];
  return out;
}
/** Comparação resistente a diferenças de tempo; evita comparar strings secretas diretamente. */
async function sameSecret(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all(
    [provided, expected].map(async (value) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))))
  );
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

/**
 * O secret configurado no servidor não autentica, sozinho, o chamador.
 * Se o teste no painel já enviar a chave administrativa implicitamente,
 * não será necessário preencher headers manualmente.
 * O Cron pode enviar x-orchestrator-secret a partir do Vault.
 * Chamadas completamente anônimas continuam bloqueadas.
 */
async function authorize(req: Request): Promise<boolean> {
  const suppliedSecret = req.headers.get("x-orchestrator-secret") ?? "";
  const authorization = req.headers.get("authorization") ?? "";
  const apiKey = req.headers.get("apikey") ?? "";

  if (ORCHESTRATOR_SECRET.length >= 32 &&
      await sameSecret(suppliedSecret, ORCHESTRATOR_SECRET)) {
    return true;
  }

  // Alternativa para ferramentas administrativas que já enviam a
  // service_role legada automaticamente; nunca aceitar anon/publishable.
  if (SERVICE_ROLE_KEY &&
      (await sameSecret(authorization, `Bearer ${SERVICE_ROLE_KEY}`) ||
       await sameSecret(apiKey, SERVICE_ROLE_KEY))) {
    return true;
  }

  return false;
}
async function cursor(syncType: "catalog" | "issues" | "current_labels" | "label_events" | "reconcile"):
  Promise<CursorRecord | null> {
  const { data, error } = await db.from("sync_cursors_gitlab")
    .select("id,cursor,updated_at")
    .eq("integration_id", INTEGRATION_ID)
    .eq("sync_type", syncType)
    .is("project_id", null)
    .maybeSingle();
  check(error);
  return data as CursorRecord | null;
}
async function resetCursor(type: "catalog" | "issues" | "current_labels" | "label_events"):
  Promise<void> {
  let progress: Record<string, unknown>;
  if (type === "catalog") progress = { page: 1, complete: false };
  else if (type === "issues") progress = { mode: "group", year: 2026, month: 1, page: 1, complete: false };
  else if (type === "current_labels") progress = { task: "current_labels", last_issue_id: null, complete: false };
  else progress = { task: "label_events", last_issue_id: null, current_issue_id: null, page: 1, complete: false };
  const { error } = await db.from("sync_cursors_gitlab")
    .update({ cursor: progress, last_successful_at: null, updated_at: iso() })
    .eq("integration_id", INTEGRATION_ID)
    .eq("sync_type", type)
    .is("project_id", null);
  check(error);
}
async function countPending(field: "labels_synced_at" | "label_events_synced_at"):
  Promise<number> {
  const { count, error } = await db.from("issues_gitlab")
    .select("id", { count: "exact", head: true })
    .eq("integration_id", INTEGRATION_ID).is(field, null);
  check(error);
  return count ?? 0;
}
async function projectIds(): Promise<number[]> {
  const ids: number[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await db.from("projects_gitlab")
      .select("gitlab_id")
      .eq("integration_id", INTEGRATION_ID)
      .eq("import_enabled", true)
      .order("gitlab_id", { ascending: true })
      .range(from, from + 499);
    check(error);
    const batch = (data ?? []).map((p: { gitlab_id: number | string }) => Number(p.gitlab_id));
    ids.push(...batch);
    if (batch.length < 500) break;
    from += 500;
  }
  return ids;
}
async function readState(): Promise<State> {
  const { data, error } = await db.from("orchestrator_state_gitlab")
    .select("integration_id,phase,cycle_number,known_project_ids,phase_entered_at,next_run_at,lease_owner,lease_until,failure_count")
    .eq("integration_id", INTEGRATION_ID).single();
  check(error);
  return data as State;
}
async function acquire(owner: string): Promise<State | null> {
  const now = iso();
  const { data, error } = await db.from("orchestrator_state_gitlab")
    .update({ lease_owner: owner, lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
      last_tick_at: now, updated_at: now })
    .eq("integration_id", INTEGRATION_ID)
    .or(`lease_until.is.null,lease_until.lt.${now}`)
    .select("integration_id,phase,cycle_number,known_project_ids,phase_entered_at,next_run_at,lease_owner,lease_until,failure_count")
    .maybeSingle();
  check(error);
  return data as State | null;
}
async function transition(owner: string, changes: Record<string, unknown>): Promise<void> {
  const { data, error } = await db.from("orchestrator_state_gitlab")
    .update({ ...changes, lease_owner: null, lease_until: null, updated_at: iso(),
      failure_count: 0, last_error: null })
    .eq("integration_id", INTEGRATION_ID).eq("lease_owner", owner)
    .select("integration_id");
  check(error);
  if (data?.length !== 1) throw new Error("Orquestrador perdeu o lease; estado não alterado");
}
async function invoke(phase: Exclude<Phase, "idle">): Promise<{status: number; data: Record<string, unknown>}> {
  const name = FUNCTIONS[phase];
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Nome de função inválido: ${phase}`);
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "apikey": SERVICE_ROLE_KEY,
    },
    body: "{}",
    signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
  });
  const body = await response.text();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body) as Record<string, unknown>; }
  catch { throw new Error(`${name} retornou resposta inválida (HTTP ${response.status}): ${body.slice(0, 250)}`); }
  if (!response.ok || parsed?.error) {
    throw new Error(`${name} HTTP ${response.status}: ${String(parsed?.error ?? body).slice(0, 500)}`);
  }
  if (typeof parsed.complete !== "boolean") {
    throw new Error(`${name} não retornou complete booleano. Confira nome/deploy da função.`);
  }
  return { status: response.status, data: parsed };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return respond({ error: "Use POST" }, 405);
  if (!(await authorize(req))) return respond({ error: "Não autorizado: a invocação precisa de credencial administrativa válida" }, 401);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return respond({ error: "Supabase não configurado" }, 500);

  const owner = crypto.randomUUID();
  let leased = false;
  let runId: string | null = null;
  let stage: Phase = "projects";
  try {
    const { data: integration, error: integrationError } = await db
      .from("integrations_gitlab").select("id,is_active").eq("id", INTEGRATION_ID).single();
    check(integrationError);
    if (!integration?.is_active) return respond({ error: "Integração GitLab inativa" }, 409);

    const current = await readState();
    if (Date.parse(current.next_run_at) > Date.now()) {
      return respond({ status: "waiting", phase: current.phase,
        next_run_at: current.next_run_at, complete: current.phase === "idle" });
    }
    const state = await acquire(owner);
    if (!state) return respond({ status: "busy", message: "Outro processamento está em andamento" }, 202);
    leased = true;
    stage = state.phase;
    const now = iso();
    const run = await db.from("orchestrator_runs_gitlab")
      .insert({ integration_id: INTEGRATION_ID, phase: stage, status: "running",
        function_name: stage === "idle" ? null : FUNCTIONS[stage] })
      .select("id").single();
    check(run.error);
    runId = run.data!.id;

    let phaseAfter = stage;
    let worker: string | null = null;
    let workerResult: Record<string, unknown> = {};
    let httpStatus: number | null = null;
    let newKnownIds: number[] | null = null;
    let nextRunAt = iso();
    let nextCycleNumber = state.cycle_number;
    let nextCycleStartedAt: string | null = null;
    let note = "";

    if (stage === "idle") {
      phaseAfter = "projects";
      nextCycleNumber += 1;
      nextCycleStartedAt = now;
      note = "Iniciada nova rodada de sincronização";
    } else if (stage === "projects") {
      const saved = await cursor("catalog");
      if (state.cycle_number > 0 && saved?.cursor?.complete === true &&
          Date.parse(saved.updated_at) < Date.parse(state.phase_entered_at)) {
        await resetCursor("catalog");
      }
      const currentCursor = await cursor("catalog");
      if (currentCursor?.cursor?.complete === true) {
        newKnownIds = await projectIds();
        const old = new Set((state.known_project_ids ?? []).map(Number));
        const newlyAdded = newKnownIds.filter((id) => !old.has(id));
        if (newlyAdded.length > 0 && state.cycle_number > 0) {
          await resetCursor("issues");
          note = `${newlyAdded.length} projeto(s) novos: reiniciada carga de Issues 2026`;
        }
        phaseAfter = "issues";
      } else {
        worker = FUNCTIONS.projects;
        const result = await invoke("projects");
        httpStatus = result.status;
        workerResult = summary(result.data);
        if (result.data.complete === true) {
          newKnownIds = await projectIds();
          const old = new Set((state.known_project_ids ?? []).map(Number));
          const newlyAdded = newKnownIds.filter((id) => !old.has(id));
          if (newlyAdded.length > 0 && state.cycle_number > 0) {
            await resetCursor("issues");
            note = `${newlyAdded.length} projeto(s) novos: reiniciada carga de Issues 2026`;
          }
          phaseAfter = "issues";
        }
      }
    } else if (stage === "issues") {
      const saved = await cursor("issues");
      if (saved?.cursor?.complete === true) {
        phaseAfter = "catalog_details";
      } else {
        worker = FUNCTIONS.issues;
        const result = await invoke("issues");
        httpStatus = result.status;
        workerResult = summary(result.data);
        if (result.data.complete === true) phaseAfter = "catalog_details";
      }
    } else if (stage === "catalog_details") {
      worker = FUNCTIONS.catalog_details;
      const result = await invoke("catalog_details");
      httpStatus = result.status;
      workerResult = summary(result.data);
      if (result.data.complete === true) phaseAfter = "reconcile";
    } else if (stage === "reconcile") {
      const saved = await cursor("reconcile");
      // Recuperação de crash: worker concluiu, mas orquestrador pode não ter transitado.
      if (saved?.cursor?.complete === true &&
          Date.parse(saved.updated_at) >= Date.parse(state.phase_entered_at)) {
        phaseAfter = "current_labels";
        note = "Rodada de reconciliação já concluída";
      } else {
        worker = FUNCTIONS.reconcile;
        const result = await invoke("reconcile");
        httpStatus = result.status;
        workerResult = summary(result.data);
        if (result.data.complete === true) phaseAfter = "current_labels";
      }
    } else if (stage === "current_labels" || stage === "label_events") {
      const type = stage;
      const pending = await countPending(type === "current_labels"
        ? "labels_synced_at" : "label_events_synced_at");
      if (pending === 0) {
        phaseAfter = nextPhase(stage);
        note = "Sem Issues pendentes nesta etapa";
      } else {
        const saved = await cursor(type);
        const alreadyVisitedThisPhase = !!saved &&
          Date.parse(saved.updated_at) >= Date.parse(state.phase_entered_at);
        if (!alreadyVisitedThisPhase) {
          // Funções atuais não filtram pendências: reiniciar varredura completa.
          await resetCursor(type);
        } else if (saved?.cursor?.complete === true) {
          throw new Error(`${pending} Issue(s) seguem pendentes após a varredura ${type}. Investigue antes de prosseguir.`);
        }
        worker = FUNCTIONS[stage];
        const result = await invoke(stage);
        httpStatus = result.status;
        workerResult = summary(result.data);
        if (result.data.complete === true) {
          const remaining = await countPending(type === "current_labels"
            ? "labels_synced_at" : "label_events_synced_at");
          if (remaining > 0) {
            throw new Error(`${remaining} Issue(s) pendentes após concluir ${type}. Verifique os registros.`);
          }
          phaseAfter = nextPhase(stage);
        }
      }
    }

    const end = iso();
    const runUpdate = await db.from("orchestrator_runs_gitlab")
      .update({ status: "succeeded", finished_at: end, http_status: httpStatus,
        response_summary: { ...workerResult, note, next_phase: phaseAfter } })
      .eq("id", runId);
    check(runUpdate.error);

    if (phaseAfter === "idle") nextRunAt = new Date(Date.now() + CYCLE_INTERVAL_MS).toISOString();
    const patch: Record<string, unknown> = {
      phase: phaseAfter, next_run_at: nextRunAt, last_worker: worker,
    };
    if (phaseAfter !== stage) patch.phase_entered_at = end;
    if (newKnownIds) patch.known_project_ids = newKnownIds;
    if (nextCycleStartedAt) patch.cycle_started_at = nextCycleStartedAt;
    if (nextCycleNumber !== state.cycle_number) patch.cycle_number = nextCycleNumber;
    if (phaseAfter === "idle") patch.last_successful_cycle_at = end;
    await transition(owner, patch);
    leased = false;
    return respond({ status: "ok", group_id: 320, integration_id: INTEGRATION_ID,
      phase_before: stage, phase_after: phaseAfter, worker, worker_result: workerResult,
      note, next_run_at: nextRunAt, complete: phaseAfter === "idle" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("gitlab-sync-orchestrator", { stage, error: message,
      stack: e instanceof Error ? e.stack : undefined });
    if (runId) {
      const { error } = await db.from("orchestrator_runs_gitlab")
        .update({ status: "failed", error_message: message.slice(0, 2000), finished_at: iso() })
        .eq("id", runId);
      if (error) console.error("Erro ao atualizar log", error.message);
    }
    let retryAfterSeconds = 0;
    if (leased) {
      try {
        const { data, error } = await db.from("orchestrator_state_gitlab")
          .select("failure_count").eq("integration_id", INTEGRATION_ID).single();
        check(error);
        const failures = Math.min((data?.failure_count ?? 0) + 1, 100);
        const backoff = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(failures - 1, 10));
        retryAfterSeconds = Math.ceil(backoff / 1000);
        const { error: saveError } = await db.from("orchestrator_state_gitlab")
          .update({ lease_owner: null, lease_until: null, failure_count: failures,
            next_run_at: new Date(Date.now() + backoff).toISOString(),
            last_error: message.slice(0, 2000), updated_at: iso() })
          .eq("integration_id", INTEGRATION_ID).eq("lease_owner", owner);
        check(saveError);
      } catch (stateError) { console.error("Erro ao registrar retentativa", stateError); }
    }
    return respond({ status: "error", phase: stage, error: message,
      retry_after_seconds: retryAfterSeconds }, 502);
  }
});
