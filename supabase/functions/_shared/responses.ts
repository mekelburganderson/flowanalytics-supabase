import { corsHeaders } from "./cors.ts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function success(data: unknown): Response {
  return jsonResponse({ success: true, data }, 200);
}

export function badRequest(message: string): Response {
  return jsonResponse({ success: false, error: message }, 400);
}

export function conflict(message: string): Response {
  return jsonResponse({ success: false, error: message }, 409);
}

export function internalError(error: unknown): Response {
  return jsonResponse({ success: false, error: errorMessage(error) }, 500);
}
