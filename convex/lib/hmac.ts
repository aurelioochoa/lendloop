/**
 * HMAC-SHA256 request signing shared by both directions of the n8n integration.
 *
 * Signed message: `${timestamp}.${METHOD}.${path}.${body}`
 *   - timestamp: unix seconds, sent in X-LendLoop-Timestamp
 *   - signature: hex digest, sent in X-LendLoop-Signature as "sha256=<hex>"
 * Binding method + path stops a valid signature for one endpoint being replayed
 * against another; the timestamp window limits replay of a captured request.
 * Uses Web Crypto, so it runs in the default Convex runtime (no Node needed).
 */

const encoder = new TextEncoder();

export const SIGNATURE_HEADER = "X-LendLoop-Signature";
export const TIMESTAMP_HEADER = "X-LendLoop-Timestamp";
export const EVENT_ID_HEADER = "X-LendLoop-Event-Id";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signedMessage(
  timestamp: string,
  method: string,
  path: string,
  body: string,
): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison so the check doesn't leak how many characters matched. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signRequest(args: {
  secret: string;
  method: string;
  path: string;
  body: string;
  nowSeconds?: number;
}): Promise<{ timestamp: string; signature: string }> {
  const timestamp = String(args.nowSeconds ?? Math.floor(Date.now() / 1000));
  const hex = await hmacSha256Hex(
    args.secret,
    signedMessage(timestamp, args.method, args.path, args.body),
  );
  return { timestamp, signature: `sha256=${hex}` };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifySignedRequest(args: {
  secret: string | undefined;
  timestamp: string | null;
  signature: string | null;
  method: string;
  path: string;
  body: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Promise<VerifyResult> {
  if (!args.secret) return { ok: false, reason: "server secret not configured" };
  if (!args.timestamp || !args.signature) return { ok: false, reason: "missing signature headers" };
  if (!/^\d{1,12}$/.test(args.timestamp)) return { ok: false, reason: "bad timestamp" };

  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(args.timestamp)) > tolerance) {
    return { ok: false, reason: "timestamp outside allowed window" };
  }

  const expected = `sha256=${await hmacSha256Hex(
    args.secret,
    signedMessage(args.timestamp, args.method, args.path, args.body),
  )}`;
  return timingSafeEqual(expected, args.signature)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}
