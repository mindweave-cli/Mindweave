/**
 * headerValue.ts — putting an arbitrary body value into an HTTP header value.
 *
 * Streamable HTTP mirrors selected body fields into headers so intermediaries can route
 * without parsing the body. Those fields are written by third parties and are not
 * constrained to anything a header can carry: a tool name is only SHOULD-constrained to
 * safe characters, a resource URI is not constrained at all, and a tool argument can be
 * any string a user typed. The spec's answer is a sentinel encoding rather than a
 * rejection, so this is the one place that decides when to reach for it.
 *
 * Its own module because two unrelated callers need it — the transport, for `Mcp-Name`,
 * and the catalog layer, for `Mcp-Param-*` — and the second should not have to import a
 * fetch client to encode a string.
 */

/**
 * A value that needs no rescuing: visible ASCII, space or tab only (RFC 9110 field
 * values), no leading or trailing whitespace, and nothing that could be mistaken for an
 * already-encoded value.
 */
function isHeaderSafe(value: string): boolean {
  if (/[^\t\x20-\x7e]/.test(value)) return false;
  if (/^[\t\x20]|[\t\x20]$/.test(value)) return false;
  return !/^=\?base64\?[\s\S]*\?=$/.test(value);
}

/**
 * Mirror one body value into a header value (pure).
 *
 * Anything outside the safe set travels in the spec's sentinel `=?base64?...?=`, which
 * servers decode before comparing the header against the body. A plain value that merely
 * LOOKS like the sentinel is encoded too: otherwise a server would decode a value the
 * client never encoded, compare the wrong bytes, and reject a legitimate request.
 */
export function encodeHeaderValue(value: string): string {
  if (isHeaderSafe(value)) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
