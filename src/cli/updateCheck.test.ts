/**
 * updateCheck.test.ts — the quiet version check, exercised without a real network
 * call or a real disk write. Every dependency is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdate, compareVersions } from "./updateCheck.js";

function fakeFetch(version: string | null, ok = true): typeof fetch {
  return (async () => {
    if (version === null) throw new Error("network down");
    return { ok, json: async () => ({ version }) } as Response;
  }) as typeof fetch;
}

test("compareVersions orders by major, then minor, then patch", () => {
  assert.ok(compareVersions("2.1.2", "2.1.1") > 0);
  assert.ok(compareVersions("2.2.0", "2.1.9") > 0);
  assert.ok(compareVersions("3.0.0", "2.9.9") > 0);
  assert.equal(compareVersions("2.1.1", "2.1.1"), 0);
  assert.ok(compareVersions("2.1.0", "2.1.1") < 0);
});

test("a malformed version reads as 0 rather than throwing", () => {
  assert.doesNotThrow(() => compareVersions("not-a-version", "2.1.1"));
  assert.doesNotThrow(() => compareVersions("2.1.1", ""));
});

test("a newer registry version is reported", async () => {
  const result = await checkForUpdate({
    running: "2.1.1",
    now: 1000,
    fetchImpl: fakeFetch("2.1.2"),
    readCacheImpl: () => null,
    writeCacheImpl: () => {},
  });
  assert.equal(result, "2.1.2");
});

test("running the latest version already reports nothing", async () => {
  const result = await checkForUpdate({
    running: "2.1.1",
    now: 1000,
    fetchImpl: fakeFetch("2.1.1"),
    readCacheImpl: () => null,
    writeCacheImpl: () => {},
  });
  assert.equal(result, null);
});

test("an older registry answer (a rollback, a mirror lag) is never reported as an update", async () => {
  const result = await checkForUpdate({
    running: "2.1.1",
    now: 1000,
    fetchImpl: fakeFetch("2.0.9"),
    readCacheImpl: () => null,
    writeCacheImpl: () => {},
  });
  assert.equal(result, null);
});

test("a cached answer inside the interval is used instead of a new fetch", async () => {
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    return { ok: true, json: async () => ({ version: "9.9.9" }) } as Response;
  }) as typeof fetch;
  const result = await checkForUpdate({
    running: "2.1.1",
    now: 1000,
    fetchImpl,
    readCacheImpl: () => ({ checkedAt: 500, latest: "2.1.2" }),
    writeCacheImpl: () => {},
  });
  assert.equal(result, "2.1.2", "the cached newer version should still be reported");
  assert.equal(fetched, false, "a fresh cache entry must not trigger a network call");
});

test("a cache past the interval is refreshed", async () => {
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    return { ok: true, json: async () => ({ version: "2.1.3" }) } as Response;
  }) as typeof fetch;
  const DAY = 24 * 60 * 60 * 1000;
  const result = await checkForUpdate({
    running: "2.1.1",
    now: DAY * 2,
    fetchImpl,
    readCacheImpl: () => ({ checkedAt: 0, latest: "2.1.2" }),
    writeCacheImpl: () => {},
  });
  assert.equal(fetched, true, "a stale cache entry should trigger a fresh fetch");
  assert.equal(result, "2.1.3");
});

test("a failed fetch reports nothing and writes no cache", async () => {
  let wrote = false;
  const result = await checkForUpdate({
    running: "2.1.1",
    now: 1000,
    fetchImpl: fakeFetch(null),
    readCacheImpl: () => null,
    writeCacheImpl: () => {
      wrote = true;
    },
  });
  assert.equal(result, null);
  assert.equal(wrote, false, "a failed check should not go quiet for a day on one bad request");
});

test("a non-OK response is treated the same as a network failure", async () => {
  const result = await checkForUpdate({
    running: "2.1.1",
    now: 1000,
    fetchImpl: fakeFetch("2.1.2", false),
    readCacheImpl: () => null,
    writeCacheImpl: () => {},
  });
  assert.equal(result, null);
});

test("MINDWEAVE_NO_UPDATE_CHECK skips the check entirely", async () => {
  const prev = process.env.MINDWEAVE_NO_UPDATE_CHECK;
  process.env.MINDWEAVE_NO_UPDATE_CHECK = "1";
  try {
    let called = false;
    const result = await checkForUpdate({
      running: "2.1.1",
      fetchImpl: (async () => {
        called = true;
        return { ok: true, json: async () => ({ version: "9.9.9" }) } as Response;
      }) as typeof fetch,
    });
    assert.equal(result, null);
    assert.equal(called, false, "the opt-out must prevent the fetch, not just discard its result");
  } finally {
    if (prev === undefined) delete process.env.MINDWEAVE_NO_UPDATE_CHECK;
    else process.env.MINDWEAVE_NO_UPDATE_CHECK = prev;
  }
});

test("an unknown running version skips the check rather than comparing against nothing", async () => {
  let called = false;
  const result = await checkForUpdate({
    running: "",
    fetchImpl: (async () => {
      called = true;
      return { ok: true, json: async () => ({ version: "2.1.2" }) } as Response;
    }) as typeof fetch,
  });
  assert.equal(result, null);
  assert.equal(called, false);
});
