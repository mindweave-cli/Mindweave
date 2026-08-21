/**
 * paramHeaders.test.ts — `x-mcp-header` validation and extraction.
 *
 * Two failure directions, and they pull against each other. Being too lax means sending
 * a header a server rejects, or worse, letting a third party choose a header NAME we
 * emit. Being too strict means dropping a tool that would have worked, which the user
 * experiences as the tool simply not existing. Both sides are asserted here rather than
 * only the happy path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanParamHeaders, paramHeaders, type ParamAnnotation } from "./paramHeaders.js";

/** The spec's own worked example (execute_sql / Region). */
const SPEC_SCHEMA = {
  type: "object",
  properties: {
    region: { type: "string", description: "The region to execute the query in", "x-mcp-header": "Region" },
    query: { type: "string", description: "The SQL query to execute" },
  },
  required: ["region", "query"],
};

function ok(schema: unknown): readonly ParamAnnotation[] {
  const scan = scanParamHeaders(schema);
  assert.ok(scan.ok, `expected a clean scan, got: ${scan.ok ? "" : scan.reason}`);
  return scan.annotations;
}

function rejected(schema: unknown): string {
  const scan = scanParamHeaders(schema);
  assert.equal(scan.ok, false, "expected this schema to be rejected");
  return scan.ok ? "" : scan.reason;
}

test("the spec's example yields one annotation and one header", () => {
  const annotations = ok(SPEC_SCHEMA);
  assert.deepEqual(annotations, [{ path: ["region"], header: "Region", type: "string" }]);
  assert.deepEqual(paramHeaders(annotations, { region: "us-west1", query: "SELECT 1" }), {
    "mcp-param-Region": "us-west1",
  });
});

test("a schema with no annotations scans clean and mirrors nothing", () => {
  // The overwhelmingly common case; it must not cost the tool its place in the catalog.
  const annotations = ok({ type: "object", properties: { a: { type: "string" } } });
  assert.deepEqual(annotations, []);
  assert.deepEqual(paramHeaders(annotations, { a: "x" }), {});
});

test("nested properties are reachable; array and union members are not", () => {
  assert.deepEqual(ok({
    type: "object",
    properties: { outer: { type: "object", properties: { inner: { type: "string", "x-mcp-header": "Inner" } } } },
  }), [{ path: ["outer", "inner"], header: "Inner", type: "string" }]);

  // Every one of these puts the annotation somewhere no chain of `properties` keys
  // reaches, which the spec says invalidates the whole tool rather than being ignored.
  for (const [label, schema] of [
    ["items", { type: "object", properties: { list: { type: "array", items: { type: "object", properties: { x: { type: "string", "x-mcp-header": "X" } } } } } }],
    ["anyOf", { type: "object", properties: { a: { anyOf: [{ type: "string", "x-mcp-header": "A" }] } } }],
    ["if", { type: "object", if: { properties: { a: { type: "string", "x-mcp-header": "A" } } } }],
  ] as const) {
    assert.match(rejected(schema), /cannot be reached/, label);
  }
});

test("a header name must be a legal, non-empty, unique field name", () => {
  const at = (annotation: unknown, type = "string") => ({ type: "object", properties: { a: { type, "x-mcp-header": annotation } } });
  assert.match(rejected(at("")), /empty/);
  // Not tchar: these would let a server inject a second header, or a whole request line.
  for (const bad of ["a b", "a\r\nX-Evil: 1", "a:b", "a(b"]) {
    assert.match(rejected(at(bad)), /not a valid header name/, bad);
  }
  assert.match(
    rejected({ type: "object", properties: { a: { type: "string", "x-mcp-header": "Region" }, b: { type: "string", "x-mcp-header": "REGION" } } }),
    /both claim the header/,
    "uniqueness is case-insensitive because header names are",
  );
});

test("only string, integer and boolean may be annotated", () => {
  const at = (type: unknown) => ({ type: "object", properties: { a: { type, "x-mcp-header": "A" } } });
  for (const type of ["string", "integer", "boolean"]) assert.equal(ok(at(type)).length, 1, type);
  // `number` is excluded by the spec: 42.0 and 42 are one value and two headers.
  for (const type of ["number", "object", "array", "null", undefined, ["string", "null"]]) {
    assert.match(rejected(at(type)), /not string, integer or boolean/, String(type));
  }
});

test("values are rendered in the one form the spec names", () => {
  const annotations = ok({
    type: "object",
    properties: {
      s: { type: "string", "x-mcp-header": "S" },
      i: { type: "integer", "x-mcp-header": "I" },
      b: { type: "boolean", "x-mcp-header": "B" },
    },
  });
  assert.deepEqual(paramHeaders(annotations, { s: "x", i: -7, b: false }), {
    "mcp-param-S": "x",
    "mcp-param-I": "-7",
    "mcp-param-B": "false",
  });
});

test("an unsupplied parameter has no header", () => {
  // The spec pairs "client omits the header" with "server must not expect it", so an
  // absent value and an absent header agree. Sending an empty one would be a mismatch.
  const annotations = ok(SPEC_SCHEMA);
  assert.deepEqual(paramHeaders(annotations, { query: "SELECT 1" }), {});
  assert.deepEqual(paramHeaders(annotations, { region: null, query: "x" }), {});
});

test("a value that cannot be represented faithfully is omitted, not mangled", () => {
  const annotations = ok({ type: "object", properties: { n: { type: "integer", "x-mcp-header": "N" } } });
  // Past the safe range the decimal form is already a different number than JSON carried,
  // so there is no honest header to send. Both omitting and lying get rejected; only one
  // of them is truthful about what happened.
  assert.deepEqual(paramHeaders(annotations, { n: 2 ** 53 }), {});
  assert.deepEqual(paramHeaders(annotations, { n: 1.5 }), {});
  assert.deepEqual(paramHeaders(annotations, { n: "12" }), {}, "a string is not an integer");
  assert.deepEqual(paramHeaders(annotations, { n: 42 }), { "mcp-param-N": "42" });
});

test("unsafe values reach the header in the base64 sentinel", () => {
  const annotations = ok({ type: "object", properties: { s: { type: "string", "x-mcp-header": "S" } } });
  assert.deepEqual(paramHeaders(annotations, { s: "Hello, 世界" }), { "mcp-param-S": "=?base64?SGVsbG8sIOS4lueVjA==?=" });
  // A newline in a header value would end the field and start another one.
  assert.deepEqual(paramHeaders(annotations, { s: "a\r\nX-Evil: 1" }), { "mcp-param-S": "=?base64?YQ0KWC1FdmlsOiAx?=" });
});

test("a value is read from the exact path, never inherited", () => {
  const annotations = ok({
    type: "object",
    properties: { constructor: { type: "string", "x-mcp-header": "C" } },
  });
  // `{}.constructor` exists on every object. Reading it would put a function's name into
  // a header that the body never contained.
  assert.deepEqual(paramHeaders(annotations, {}), {});
  assert.deepEqual(paramHeaders(annotations, { constructor: "real" }), { "mcp-param-C": "real" });
});
