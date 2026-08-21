/**
 * paramHeaders.ts — mirroring annotated tool arguments into `Mcp-Param-*` headers.
 *
 * A server may mark individual parameters in a tool's `inputSchema` with `x-mcp-header`,
 * asking for their values to be repeated in HTTP headers so that a gateway can route or
 * rate-limit on them without reading the body. Supporting this is not optional for a
 * Streamable HTTP client, and skipping it does not degrade gracefully: a server MUST
 * reject a call whose annotated value is present in the body but missing from the
 * headers, with 400 and `-32020`. An ignored annotation makes the tool uncallable, not
 * merely unoptimised.
 *
 * The constraints enforced here are the spec's, and they are strict for a reason: these
 * strings are chosen by a third party and become header NAMES. Nothing is clamped,
 * escaped, or repaired into shape — a definition that violates any of them takes the
 * whole tool out of the catalog, because a tool we cannot mirror exactly is one we
 * cannot call correctly either. Reporting the tool while silently mis-calling it would
 * be the worse failure.
 */
import { encodeHeaderValue } from "./transport/headerValue.js";

/** The schema property a server annotates a parameter with. */
const ANNOTATION = "x-mcp-header";

/**
 * HTTP field-name token characters (RFC 9110 5.1). Control characters, CR and LF are
 * excluded by construction rather than by a separate check — they are simply not tchar.
 */
const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Only these carry a single unambiguous text form. `number` is excluded by the spec:
 *  `42.0` and `42` are the same value and not the same header. */
const PRIMITIVES = new Set(["string", "integer", "boolean"]);

export type ParamType = "string" | "integer" | "boolean";

export interface ParamAnnotation {
  /** Path from the schema root to the annotated property; every step a `properties` key. */
  readonly path: readonly string[];
  /** The `{Name}` half of `Mcp-Param-{Name}`, exactly as the server spelled it. */
  readonly header: string;
  readonly type: ParamType;
}

export type AnnotationScan =
  | { readonly ok: true; readonly annotations: readonly ParamAnnotation[] }
  | { readonly ok: false; readonly reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every occurrence of the annotation key anywhere in the schema, reachable or not.
 *
 * Needed because "unreachable annotations are ignored" is NOT the rule. An annotation
 * under `items`, `oneOf`, `if`, or a `$ref` invalidates the whole tool definition, so
 * they have to be counted where they should not be, not just collected where they
 * should. Comparing this total against the reachable ones is what detects the
 * difference without teaching the reachable walk about every keyword it must avoid.
 */
function countAnnotations(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, v) => n + countAnnotations(v), 0);
  if (!isPlainObject(node)) return 0;
  let total = 0;
  for (const [key, value] of Object.entries(node)) {
    // The annotation's own value is a string; there is nothing beneath it to visit.
    if (key === ANNOTATION) total += 1;
    else total += countAnnotations(value);
  }
  return total;
}

/**
 * Validate a tool's `x-mcp-header` annotations and return the reachable ones (pure).
 *
 * A tool with no annotations at all scans clean with an empty list, which is the
 * overwhelmingly common case and costs one walk of a small object.
 */
export function scanParamHeaders(inputSchema: unknown): AnnotationScan {
  const annotations: ParamAnnotation[] = [];
  // Lowercased header name -> the path that claimed it, so a clash can name both sides.
  const claimed = new Map<string, string>();
  let failure: string | null = null;

  const fail = (reason: string): void => {
    failure ??= reason;
  };

  const visit = (node: Record<string, unknown>, path: readonly string[]): void => {
    const properties = node.properties;
    if (!isPlainObject(properties)) return;
    for (const [key, child] of Object.entries(properties)) {
      if (!isPlainObject(child)) continue;
      const here = [...path, key];
      const raw = child[ANNOTATION];
      if (raw !== undefined) inspect(raw, child, here);
      // Nested objects are reachable as long as every step is a `properties` key, so the
      // descent is unconditional here and simply finds nothing under a leaf.
      visit(child, here);
    }
  };

  const inspect = (raw: unknown, child: Record<string, unknown>, path: readonly string[]): void => {
    const where = path.join(".");
    if (typeof raw !== "string" || raw === "") return fail(`'${where}' has an empty ${ANNOTATION}`);
    if (!TCHAR.test(raw)) return fail(`'${where}' has ${ANNOTATION} '${raw}', which is not a valid header name`);

    const type = child.type;
    if (typeof type !== "string" || !PRIMITIVES.has(type)) {
      return fail(`'${where}' is annotated but its type is '${String(type)}', not string, integer or boolean`);
    }

    const key = raw.toLowerCase();
    const previous = claimed.get(key);
    // Case-insensitive, because header names are. Two properties asking for the same
    // header cannot both be honoured and there is no basis for choosing.
    if (previous) return fail(`'${where}' and '${previous}' both claim the header '${raw}'`);
    claimed.set(key, where);

    annotations.push({ path, header: raw, type: type as ParamType });
  };

  if (isPlainObject(inputSchema)) visit(inputSchema, []);
  if (failure) return { ok: false, reason: failure };

  const total = countAnnotations(inputSchema);
  if (total !== annotations.length) {
    return {
      ok: false,
      reason: `${total - annotations.length} ${ANNOTATION} annotation(s) sit where they cannot be reached by a chain of 'properties' keys`,
    };
  }
  return { ok: true, annotations };
}

/** The single text form of one value, or null if it has none we may send. */
function render(value: unknown, type: ParamType): string | null {
  if (type === "string") return typeof value === "string" ? value : null;
  if (type === "boolean") return typeof value === "boolean" ? String(value) : null;
  // Outside the safe range the decimal form is already a different number than the one
  // JSON carried, so there is no faithful header to send.
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

/** Read the value at an exact property path, or undefined if the chain breaks. */
function valueAt(args: Record<string, unknown>, path: readonly string[]): unknown {
  let node: unknown = args;
  for (const key of path) {
    // Own properties only: the path comes from a third-party schema, and inherited
    // members like `constructor` are not values the caller passed.
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * The `Mcp-Param-*` headers for one call (pure).
 *
 * A parameter that was not supplied is omitted rather than sent empty — the spec pairs
 * "client omits the header" with "server must not expect it", so an absent value and an
 * absent header agree. A value we cannot represent faithfully is also omitted: both
 * omitting and sending a lossy value get the call rejected, and only one of them is
 * honest about why.
 */
export function paramHeaders(annotations: readonly ParamAnnotation[], args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const annotation of annotations) {
    const value = valueAt(args, annotation.path);
    if (value === undefined || value === null) continue;
    const text = render(value, annotation.type);
    if (text === null) continue;
    out[`mcp-param-${annotation.header}`] = encodeHeaderValue(text);
  }
  return out;
}
