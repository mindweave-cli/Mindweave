/**
 * configWrite.test.ts — turning what someone typed into a config that actually loads.
 *
 * Two properties matter more than the parsing itself. First, anything written here must
 * read back through `parseEntry`, or the writer will quietly emit configs the loader
 * drops and the server just never appears. Second, adding one server must not disturb
 * a file the user has been editing by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addServerToConfig, configPathFor, parseAddSpec, removeServerFromConfig, resolveConfigPath, serialize, splitArgs } from "./configWrite.js";
import { parseMcpConfig } from "./config.js";

const dir = () => mkdtempSync(join(tmpdir(), "mw-mcpcfg-"));
const spec = (line: string) => {
  const r = parseAddSpec(splitArgs(line));
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.spec : (undefined as never);
};

/**
 * Point `globalConfigPath()` at a disposable directory for the duration of `fn`, and
 * restore whatever `MINDWEAVE_STATE_DIR` was set to afterward — even if `fn` throws.
 *
 * `configPathFor("global", cwd)` ignores `cwd`; without this, a test exercising the
 * global scope writes into this machine's REAL `~/.mindweave/mcp.json`. That happened —
 * test fixture servers ("only-global", "shadowed") landed in a real global config and
 * showed up hung in a live session — before `globalConfigPath` read this override.
 */
async function withSandboxedGlobalConfig<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.MINDWEAVE_STATE_DIR;
  process.env.MINDWEAVE_STATE_DIR = dir();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.MINDWEAVE_STATE_DIR;
    else process.env.MINDWEAVE_STATE_DIR = prev;
  }
}

test("splitArgs keeps quoted arguments whole", () => {
  // The two things people quote here are headers and paths with spaces, and both break
  // badly when split naively.
  assert.deepEqual(splitArgs("add x npx -y pkg"), ["add", "x", "npx", "-y", "pkg"]);
  assert.deepEqual(splitArgs(`--header 'Authorization: Bearer abc' x`), ["--header", "Authorization: Bearer abc", "x"]);
  assert.deepEqual(splitArgs(`run "C:/Program Files/app.exe"`), ["run", "C:/Program Files/app.exe"]);
  assert.deepEqual(splitArgs("   "), []);
});

test("a local server parses into a stdio config", () => {
  const s = spec("github npx -y @modelcontextprotocol/server-github");
  assert.equal(s.scope, "project");
  assert.deepEqual(s.config, { type: "stdio", name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
});

test("`--` hands the rest to the SERVER, not to us", () => {
  // Without it, a server's own `--global` or `--http` would be eaten as one of ours.
  const s = spec("srv my-cmd -- --global --http --env X=1");
  assert.deepEqual(s.config, { type: "stdio", name: "srv", command: "my-cmd", args: ["--global", "--http", "--env", "X=1"] });
  assert.equal(s.scope, "project", "the server's --global is not ours");
});

test("env and headers are collected, and headers are refused on stdio", () => {
  const s = spec("pg npx pg-server --env PGHOST=localhost --env PGPASS=a=b=c");
  assert.deepEqual(s.config.type === "stdio" ? s.config.env : null, { PGHOST: "localhost", PGPASS: "a=b=c" }, "split on the FIRST = only");

  const bad = parseAddSpec(splitArgs("x cmd --header 'A: b'"));
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /--http/);
});

test("an http server needs a real URL and takes no arguments", () => {
  const s = spec("remote --http https://x.dev/mcp --header 'Authorization: Bearer t'");
  assert.deepEqual(s.config, { type: "http", name: "remote", url: "https://x.dev/mcp", headers: { Authorization: "Bearer t" } });

  assert.equal(parseAddSpec(splitArgs("x --http notaurl")).ok, false);
  assert.equal(parseAddSpec(splitArgs("x --http https://x.dev extra")).ok, false);
});

test("missing or unusable input is refused with usage, not guessed at", () => {
  for (const line of ["", "onlyname", "--http onlyname", "--- x"]) {
    assert.equal(parseAddSpec(splitArgs(line)).ok, false, `'${line}' should not parse`);
  }
  const noName = parseAddSpec(splitArgs("'' npx"));
  assert.equal(noName.ok, false);
});

test("--global switches scope, and it is not the default", () => {
  assert.equal(spec("x npx").scope, "project", "a server is usually a fact about THIS project");
  assert.equal(spec("--global x npx").scope, "global");
  assert.equal(spec("-g x npx").scope, "global");
});

test("everything written reads back through the loader", async () => {
  // The property that matters: a writer and a reader that disagree produce a server
  // that is configured and never appears, with no error anywhere.
  const path = join(dir(), "mcp.json");
  await addServerToConfig(path, spec("github npx -y pkg --env T=1"));
  await addServerToConfig(path, spec("remote --http https://x.dev/mcp"));

  const loaded = parseMcpConfig(await fs.readFile(path, "utf8"));
  assert.deepEqual(loaded.map((c) => c.name).sort(), ["github", "remote"]);
  const gh = loaded.find((c) => c.name === "github")!;
  assert.equal(gh.type === "stdio" ? gh.command : "", "npx");
  assert.deepEqual(gh.type === "stdio" ? gh.env : null, { T: "1" });
});

test("adding preserves servers and unrelated keys already in the file", async () => {
  // This file is hand-editable. Clobbering it to add one entry would be the worst
  // possible first impression of the feature.
  const path = join(dir(), "mcp.json");
  await fs.writeFile(path, JSON.stringify({ mcpServers: { existing: { command: "keep-me" } }, note: "mine" }), "utf8");
  await addServerToConfig(path, spec("added npx"));

  const root = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, Record<string, unknown>>;
  assert.equal(root.note, "mine", "unrelated keys survive");
  assert.deepEqual(Object.keys(root.mcpServers!).sort(), ["added", "existing"]);
});

test("a file using the `servers` key keeps using it", async () => {
  // Both spellings exist in the wild. Silently adding a second root key would leave
  // half the servers invisible depending on which one the reader picked.
  const path = join(dir(), "mcp.json");
  await fs.writeFile(path, JSON.stringify({ servers: { a: { command: "x" } } }), "utf8");
  await addServerToConfig(path, spec("b npx"));
  const root = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  assert.ok(root.servers, "kept the file's own key");
  assert.equal(root.mcpServers, undefined, "did not add a competing one");
});

test("re-adding the same name replaces it and says so", async () => {
  const path = join(dir(), "mcp.json");
  assert.equal((await addServerToConfig(path, spec("x old-cmd"))).replaced, false);
  const second = await addServerToConfig(path, spec("x new-cmd"));
  assert.equal(second.replaced, true);
  const loaded = parseMcpConfig(await fs.readFile(path, "utf8"));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.type === "stdio" ? loaded[0]!.command : "", "new-cmd");
});

test("an unparseable existing file does not lose the server being added", async () => {
  const path = join(dir(), "mcp.json");
  await fs.writeFile(path, "{ not json", "utf8");
  await addServerToConfig(path, spec("x npx"));
  assert.deepEqual(parseMcpConfig(await fs.readFile(path, "utf8")).map((c) => c.name), ["x"]);
});

test("remove takes a server out, and reports when there was nothing to remove", async () => {
  const path = join(dir(), "mcp.json");
  await addServerToConfig(path, spec("x npx"));
  assert.equal(await removeServerFromConfig(path, "nope"), false);
  assert.equal(await removeServerFromConfig(path, "x"), true);
  assert.deepEqual(parseMcpConfig(await fs.readFile(path, "utf8")), []);
  assert.equal(await removeServerFromConfig(join(dir(), "missing.json"), "x"), false);
});

test("serialize omits empty optionals rather than writing noise", () => {
  assert.deepEqual(serialize({ type: "stdio", name: "x", command: "c", args: [] }), { command: "c" });
  assert.deepEqual(serialize({ type: "http", name: "x", url: "https://a" }), { type: "http", url: "https://a" });
});

test("serialize persists `disabled` on both server types, and omits it when false", () => {
  // The gap this closes: `disabled` existed on the type and parseEntry read it back, but
  // nothing ever WROTE it, so a server disabled through the manager came back enabled on
  // the next launch — Disable was a this-session-only illusion.
  assert.deepEqual(
    serialize({ type: "stdio", name: "x", command: "c", args: [], disabled: true }),
    { command: "c", disabled: true },
  );
  assert.deepEqual(
    serialize({ type: "http", name: "x", url: "https://a", disabled: true }),
    { type: "http", url: "https://a", disabled: true },
  );
  // Not written at all when false — matches every other optional here being omitted
  // rather than written as noise, and round-trips identically either way.
  assert.deepEqual(serialize({ type: "stdio", name: "x", command: "c", args: [], disabled: false }), { command: "c" });
});

test("a written `disabled` flag reads back through the loader", async () => {
  const path = join(dir(), "mcp.json");
  await addServerToConfig(path, spec("x npx"));
  const config = parseMcpConfig(await fs.readFile(path, "utf8"))[0]!;
  await addServerToConfig(path, { name: "x", scope: "project", config: { ...config, disabled: true } });
  const reloaded = parseMcpConfig(await fs.readFile(path, "utf8"))[0]!;
  assert.equal(reloaded.disabled, true);
});

test("scope maps to the two real config locations", () => {
  const cwd = dir();
  assert.match(configPathFor("project", cwd), /mcp\.json$/);
  assert.notEqual(configPathFor("project", cwd), configPathFor("global", cwd));
});

test("resolveConfigPath finds the file that actually defines a server, project first", async () => {
  // `globalConfigPath()` ignores `cwd` entirely — it is ONE real, fixed path on the
  // machine running this test (`~/.mindweave/mcp.json`), unlike the project path, which
  // is naturally sandboxed by `dir()`. Writing to it without `MINDWEAVE_STATE_DIR`
  // pointed somewhere disposable would write real MCP server entries into whoever's
  // machine runs this suite — which is exactly what happened once, hence the override.
  await withSandboxedGlobalConfig(async () => {
    const cwd = dir();
    const project = configPathFor("project", cwd);
    const global = configPathFor("global", cwd);
    await addServerToConfig(global, spec("only-global npx"));
    assert.equal(await resolveConfigPath(cwd, "only-global"), global, "found on the global file");

    await addServerToConfig(project, spec("shadowed npx"));
    await addServerToConfig(global, spec("shadowed npx"));
    assert.equal(await resolveConfigPath(cwd, "shadowed"), project, "project shadows global — that's the one actually running");
  });
});

test("resolveConfigPath falls back to project when the server is on neither file", async () => {
  // Only a READ against the global path here, but sandboxed anyway: this must not depend
  // on whatever this machine's real global config happens to contain.
  await withSandboxedGlobalConfig(async () => {
    const cwd = dir();
    assert.equal(await resolveConfigPath(cwd, "never-persisted"), configPathFor("project", cwd));
  });
});
