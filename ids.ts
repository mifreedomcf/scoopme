/**
 * Token and code generation. Uses Web Crypto, which is available in both the
 * Deno function runtime and Node 18+ (so the tests exercise the real code).
 */

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Unguessable opaque token, e.g. an assignment claim token or a tracking link. */
export function secureToken(byteLength = 32): string {
  return Array.from(randomBytes(byteLength))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Human-readable ride verification code. Rotated on every reassignment; a code
 * is never reused for the same ride.
 */
export function verificationCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Deterministic idempotency key so a retried notification is not sent twice. */
export function idempotencyKey(parts: (string | number | undefined)[]): string {
  return parts.map((p) => String(p ?? "")).join("|");
}

/** Constant-time-ish string compare for codes and tokens. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
