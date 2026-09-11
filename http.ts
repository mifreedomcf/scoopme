/**
 * HTTP helpers shared by every backend function. Pure module.
 */

export interface ApiError {
  error: string;
  code: string;
  /** Field-level errors, for form error summaries. */
  fields?: { field: string; code: string; message: string }[];
}

export function ok(data: Record<string, unknown>, status = 200): Response {
  return Response.json({ ok: true, ...data }, { status });
}

export function fail(code: string, message: string, status = 400, fields?: ApiError["fields"]): Response {
  return Response.json({ ok: false, code, error: message, fields }, { status });
}

export const unauthorized = () => fail("unauthorized", "Sign in to continue.", 401);
export const forbidden = (message = "You do not have access to this action.") => fail("forbidden", message, 403);
export const notFound = (message = "Not found.") => fail("not_found", message, 404);
export const conflict = (code: string, message: string) => fail(code, message, 409);
export const rateLimited = (message = "Too many requests. Try again shortly.") =>
  fail("rate_limited", message, 429);

/**
 * Generic server error. The real error is logged server-side; the client gets a
 * code, never a stack trace or an internal message.
 */
export function serverError(): Response {
  return fail("server_error", "Something went wrong on our side. Try again, or call support.", 500);
}

/** Reject an object-shaped body that is missing or not JSON. */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface RateLimitInput {
  /** Timestamps of prior events, newest first or any order. */
  eventTimestamps: string[];
  windowMs: number;
  limit: number;
  now: Date;
}

/** Pure sliding-window rate limit, so it can be tested without a database. */
export function isRateLimited(input: RateLimitInput): boolean {
  const cutoff = input.now.getTime() - input.windowMs;
  const recent = input.eventTimestamps.filter((t) => {
    const ms = new Date(t).getTime();
    return !Number.isNaN(ms) && ms >= cutoff;
  });
  return recent.length >= input.limit;
}
