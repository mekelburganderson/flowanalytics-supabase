import { supabase } from "./supabase.ts";

type SyncControlRecord = {
  process_name: string;
  locked: boolean;
  status: string | null;
  started_at: string | null;
};

type FinishSyncSuccessOptions = {
  progress?: number | null;
  total?: number | null;
  message?: string | null;
};

async function getProcess(processName: string): Promise<SyncControlRecord> {
  const { data, error } = await supabase
    .from("integration_sync_control")
    .select("process_name, locked, status, started_at")
    .eq("process_name", processName)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(`Processo de sincronização não encontrado: ${processName}`);
  }

  return data as SyncControlRecord;
}

function elapsedMilliseconds(startedAt: string | null, finishedAt: Date): number | null {
  if (!startedAt) {
    return null;
  }

  const startedAtMs = new Date(startedAt).getTime();
  return Number.isNaN(startedAtMs) ? null : finishedAt.getTime() - startedAtMs;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startSync(processName: string): Promise<void> {
  const process = await getProcess(processName);

  if (process.locked) {
    throw new Error(`Processo de sincronização bloqueado: ${processName}`);
  }

  if (process.status === "running") {
    throw new Error(`Processo de sincronização já está em execução: ${processName}`);
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("integration_sync_control")
    .update({
      status: "running",
      started_at: now,
      last_execution_at: now,
      progress: 0,
      total: null,
      message: null,
    })
    .eq("process_name", processName)
    .eq("locked", false)
    .neq("status", "running")
    .select("process_name");

  if (error) {
    throw error;
  }

  if (!data?.length) {
    throw new Error(
      `Não foi possível iniciar o processo de sincronização: ${processName}`,
    );
  }
}

export async function finishSyncSuccess(
  processName: string,
  options: FinishSyncSuccessOptions = {},
): Promise<void> {
  const process = await getProcess(processName);
  const finishedAt = new Date();

  const { error } = await supabase
    .from("integration_sync_control")
    .update({
      status: "success",
      finished_at: finishedAt.toISOString(),
      last_success_at: finishedAt.toISOString(),
      last_duration_ms: elapsedMilliseconds(process.started_at, finishedAt),
      progress: options.progress ?? null,
      total: options.total ?? null,
      message: options.message ?? null,
    })
    .eq("process_name", processName);

  if (error) {
    throw error;
  }
}

export async function finishSyncError(
  processName: string,
  error: unknown,
): Promise<void> {
  const process = await getProcess(processName);
  const finishedAt = new Date();

  const { error: updateError } = await supabase
    .from("integration_sync_control")
    .update({
      status: "error",
      finished_at: finishedAt.toISOString(),
      last_duration_ms: elapsedMilliseconds(process.started_at, finishedAt),
      message: toErrorMessage(error),
    })
    .eq("process_name", processName);

  if (updateError) {
    throw updateError;
  }
}

export async function updateProgress(
  processName: string,
  progress: number,
  total: number | null,
): Promise<void> {
  const { error } = await supabase
    .from("integration_sync_control")
    .update({ progress, total })
    .eq("process_name", processName);

  if (error) {
    throw error;
  }
}
