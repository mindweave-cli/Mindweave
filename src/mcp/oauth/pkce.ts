/**
 * pkce.ts — the proof that the code being redeemed is being redeemed by whoever asked.
 *
 * A CLI cannot keep a client secret: anything shipped in the binary or written to a
 * config file is readable by anything else on the machine, so OAuth for native apps
 * treats us as a PUBLIC client and closes the resulting hole with PKCE instead. We invent
 * a random `verifier`, send only its SHA-256 (the `challenge`) when we send the user off
 * to approve, and send the verifier itself when we redeem the code. Anything that
 * intercepts the redirect gets a code it cannot spend, because it never saw the verifier.
 *
 * `state` is the other half and guards the other direction: it proves a callback arriving
 * on our loopback port belongs to the flow WE started, rather than to something else on
 * the machine firing a request at the port we just opened.
 *
 * All of it is one small pure-ish module on node:crypto so the encodings — which are the
 * part that silently breaks, since base64url is not base64 and a single `+` will fail an
 * exchange with a message that names none of this — live in exactly one place.
 */
import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 puts the verifier between 43 and 128 characters; 32 random bytes encode to
 *  43, which is the shortest legal value and therefore the one with nothing to spare in
 *  it. Entropy is the point, not length, and 256 bits is not the weak link. */
const VERIFIER_BYTES = 32;

export interface Pkce {
  verifier: string;
  challenge: string;
  /** Always S256. `plain` exists in the RFC and protects against nothing, so it is not
   *  offered here — a server that cannot do S256 is refused in `metadata.ts` rather than
   *  quietly downgraded to a challenge that is its own answer. */
  method: "S256";
}

/** base64url: base64 with the two URL-hostile characters swapped and the padding dropped.
 *  Everything here goes into a query string or a form body, so the plain alphabet would
 *  need escaping at every call site and would be forgotten at one of them. */
function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh verifier and its challenge. One per authorization attempt, never reused: a
 *  verifier that outlives its code is a secret with no expiry. */
export function createPkce(): Pkce {
  const verifier = base64Url(randomBytes(VERIFIER_BYTES));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** An opaque value tying a callback to the request that caused it. */
export function randomState(): string {
  return base64Url(randomBytes(VERIFIER_BYTES));
}

/**
 * Compare two `state` values without leaking where they first differ (pure).
 *
 * `===` on strings short-circuits at the first mismatched character, and the callback URL
 * is attacker-supplied, so the comparison time is a signal about our secret. The amount
 * of signal is small and the fix is three lines, which is the wrong trade to skip.
 */
export function stateMatches(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}
