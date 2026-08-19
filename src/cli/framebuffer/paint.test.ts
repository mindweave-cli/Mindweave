/**
 * paint.test.ts — the framebuffer renderer, proved by ROUND TRIP.
 *
 * The property that matters is not "does the diff look small". It is:
 *
 *     applying paint(A, B) to a terminal showing A must produce exactly B.
 *
 * If that ever fails the screen is corrupt, and it is the kind of corruption that
 * persists — a stale character or a colour that never clears sits there for the rest
 * of the session. So almost every test here is the same shape: build two frames,
 * paint the difference, apply that difference to the first grid with the parser
 * (which models a terminal), and assert the result is cell-for-cell the second.
 *
 * That works because `parse.ts` understands cursor positioning as well as styling,
 * so it can consume `paint`'s own output. The two modules check each other: a bug in
 * either shows up here as a mismatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen } from "./screen.js";
import { parseFrame } from "./parse.js";
import { paint } from "./paint.js";

const W = 40;
const H = 8;

/** A grid holding `frame`, drawn from blank. */
function screenOf(frame: string, width = W, height = H): Screen {
  const s = new Screen(width, height);
  parseFrame(s, frame);
  return s;
}

/** Every cell, as a comparable snapshot. */
function snapshot(s: Screen): string {
  const parts: string[] = [];
  for (let i = 0; i < s.chars.length; i++) {
    parts.push(`${s.chars[i]}/${s.fg[i]}/${s.bg[i]}/${s.attrs[i]}`);
  }
  return parts.join(" ");
}

/**
 * The core assertion: paint the difference, apply it, and require the result to be
 * identical to the target.
 */
function roundTrip(before: string, after: string, width = W, height = H): string {
  const a = screenOf(before, width, height);
  const b = screenOf(after, width, height);
  const escape = paint(a, b);
  // `a` is the terminal's current contents; applying the escape must land it on `b`.
  parseFrame(a, escape);
  assert.equal(snapshot(a), snapshot(b), `round trip failed.\nescape: ${JSON.stringify(escape)}`);
  return escape;
}

test("an unchanged frame emits nothing at all", () => {
  const frame = "hello\nworld";
  const a = screenOf(frame);
  const b = screenOf(frame);
  assert.equal(paint(a, b), "", "an idle frame must put zero bytes on the terminal");
});

test("one changed character costs one short escape, not a screen", () => {
  const escape = roundTrip("hello world\nsecond line", "hello WORLD\nsecond line");
  // The whole frame is ~24 characters of content; the update must be a small
  // fraction of that, or the diff is not earning its keep.
  assert.ok(escape.length < 30, `expected a small update, got ${escape.length} bytes: ${JSON.stringify(escape)}`);
  assert.ok(escape.includes("WORLD"), escape);
  // And it must NOT have rewritten the untouched row.
  assert.ok(!escape.includes("second line"), `an unchanged row was rewritten: ${JSON.stringify(escape)}`);
});

test("colour changes round-trip, including 256-palette and truecolour", () => {
  roundTrip("plain text", "\x1b[31mred text\x1b[39m");
  roundTrip("\x1b[31mred\x1b[39m", "\x1b[32mgreen\x1b[39m");
  roundTrip("plain", "\x1b[38;5;213mpalette\x1b[39m");
  roundTrip("plain", "\x1b[38;2;10;200;30mtruecolour\x1b[39m");
  roundTrip("\x1b[38;2;10;200;30mtruecolour\x1b[39m", "plain");
});

test("background colours round-trip independently of foreground", () => {
  roundTrip("plain", "\x1b[41mred bg\x1b[49m");
  roundTrip("\x1b[41mred bg\x1b[49m", "\x1b[31;44mboth\x1b[0m");
});

test("attributes round-trip, including being turned OFF", () => {
  // Turning an attribute off is the case that needs a full reset — the direction
  // that silently leaves stale bold on screen if it is got wrong.
  roundTrip("plain", "\x1b[1mbold\x1b[22m");
  roundTrip("\x1b[1mbold\x1b[22m", "plain");
  roundTrip("\x1b[1;4mbold underline\x1b[0m", "\x1b[1mjust bold\x1b[22m");
  roundTrip("\x1b[2mdim\x1b[22m", "\x1b[3mitalic\x1b[23m");
});

test("a frame that ends mid-style resets, so nothing after it is tinted", () => {
  // The grid is sized so the LAST cell painted is itself styled. Without that there
  // are trailing default cells whose own `39`/`49` already leave the pen clean — the
  // first version of this test used a wide grid and was asserting nothing.
  const a = screenOf("abc", 3, 1);
  const b = screenOf("\x1b[31mxyz", 3, 1);
  const escape = paint(a, b);
  assert.ok(escape.endsWith("\x1b[0m"), `must end clean, got ${JSON.stringify(escape)}`);
});

test("changes scattered across many rows all land", () => {
  const before = ["row one", "row two", "row three", "row four", "row five"].join("\n");
  const after = ["row ONE", "row two", "row THREE", "row four", "row FIVE"].join("\n");
  const escape = roundTrip(before, after);
  assert.ok(!escape.includes("row two"), `an untouched row was rewritten: ${JSON.stringify(escape)}`);
});

test("a completely different frame still round-trips", () => {
  // The worst case, and the one where the diff saves nothing — it must still be
  // CORRECT, which is the only thing that matters here.
  roundTrip(
    ["aaaa", "bbbb", "cccc", "dddd"].join("\n"),
    ["\x1b[31mwxyz\x1b[39m", "\x1b[1m1234\x1b[22m", "!!!!", "\x1b[38;5;9m????\x1b[39m"].join("\n"),
  );
});

test("shorter and longer lines round-trip — cleared tails do not linger", () => {
  // Text vanishing is where a naive diff leaves ghosts: the old characters are still
  // on screen and nothing wrote over them.
  roundTrip("a long line of text here", "short");
  roundTrip("short", "a long line of text here");
  roundTrip("line one\nline two\nline three", "line one");
});

test("wide characters round-trip and keep the rest of the row aligned", () => {
  // A CJK character or emoji occupies two columns. If the continuation column is
  // mishandled every cell after it on the row is off by one, which is the most
  // visible possible corruption.
  roundTrip("plain ascii here", "世界 wide here");
  roundTrip("世界 wide here", "plain ascii here");
  roundTrip("a🔥b", "a🔥c");
  roundTrip("ab", "a🔥");
});

test("emitting nothing for a wide character's second column is not a gap", () => {
  // Guards the specific hazard: the continuation cell must not print a stray blank,
  // because the terminal has already advanced the cursor past it.
  const a = screenOf("xx rest of row");
  const b = screenOf("世 rest of row");
  const escape = paint(a, b);
  parseFrame(a, escape);
  assert.equal(snapshot(a), snapshot(b));
});

test("adjacent changes become ONE run, not one escape per cell", () => {
  const a = screenOf("aaaaaaaaaa");
  const b = screenOf("bbbbbbbbbb");
  const escape = paint(a, b);
  // Ten changed cells, positioned once. Counting cursor-position sequences is the
  // direct test of the run batching that makes this renderer worth having.
  const moves = escape.match(/\x1b\[\d+;\d+H/g)?.length ?? 0;
  assert.equal(moves, 1, `expected a single cursor move for a contiguous run, got ${moves}: ${JSON.stringify(escape)}`);
});

test("a small unchanged gap is bridged rather than jumped over", () => {
  // Re-printing a few identical characters is cheaper than the escape to skip them.
  // The gap here is 3 cells — comfortably inside BRIDGE_GAP. An earlier version of
  // this fixture had an 8-cell gap, which is correctly NOT bridged, so the test was
  // passing for the wrong reason and could not tell bridging from its absence.
  const a = screenOf("abcdefghij");
  const b = screenOf("XbcdEfghij");
  const escape = paint(a, b);
  const moves = escape.match(/\x1b\[\d+;\d+H/g)?.length ?? 0;
  assert.ok(moves === 1, `expected the gap to be BRIDGED into one run, got ${moves} moves: ${JSON.stringify(escape)}`);
  parseFrame(a, escape);
  assert.equal(snapshot(a), snapshot(b));
});

test("two distant changes on ONE row both land in the right columns", () => {
  // The case that catches cursor-position bookkeeping. After writing the first run
  // the cursor sits one past its last cell; the second run is reached by a relative
  // nudge or an absolute move computed from that. If the tracked column is off by
  // even one, the second run lands shifted — and every test above still passes,
  // because none of them has two runs separated by more than the bridging gap.
  // Verified by red-check: `curX = end` instead of `end + 1` passes everything else.
  const before = "LEFT..................RIGHT";
  const after = "left..................right";
  const escape = roundTrip(before, after);
  const moves = (escape.match(/\x1b\[\d+;\d+H/g)?.length ?? 0) + (escape.match(/\x1b\[\d+C/g)?.length ?? 0);
  assert.ok(moves >= 2, `expected two separate runs, got ${moves}: ${JSON.stringify(escape)}`);
  assert.ok(!escape.includes("."), `the untouched middle was rewritten: ${JSON.stringify(escape)}`);
});

test("three runs on one row keep their columns", () => {
  roundTrip("AAA.........BBB.........CCC", "xxx.........yyy.........zzz");
});

test("the style pen carries across rows — one colour costs one sequence", () => {
  const a = new Screen(W, H);
  const b = screenOf("\x1b[31mred one\nred two\nred three\x1b[39m");
  const escape = paint(a, b);
  const sgrCount = escape.match(/\x1b\[[0-9;]*m/g)?.length ?? 0;
  // One to turn red on, one to reset at the end. Re-stating it per row would be the
  // bug this catches.
  assert.ok(sgrCount <= 3, `pen not carried across rows: ${sgrCount} SGR sequences in ${JSON.stringify(escape)}`);
});

test("originRow offsets every absolute move, for a grid that is not at the top", () => {
  const a = screenOf("aaa");
  const b = screenOf("bbb");
  const escape = paint(a, b, 5);
  assert.ok(escape.includes("\x1b[5;1H"), `expected row 5, got ${JSON.stringify(escape)}`);
});

test("mismatched grid sizes are refused rather than silently corrupting the screen", () => {
  assert.throws(() => paint(new Screen(10, 4), new Screen(12, 4)), /differ in size/);
});

test("a randomised soak: any frame can become any other, correctly", () => {
  // The tests above each pin one mechanism. This is the one that catches the
  // interaction between them — style carried across a wide character across a
  // bridged gap at the end of a row, and every other combination nobody thought to
  // write down.
  const alphabet = ["a", "b", " ", "世", "🔥", "z"];
  const styles = ["", "\x1b[31m", "\x1b[1m", "\x1b[38;5;99m", "\x1b[38;2;1;2;3m", "\x1b[0m", "\x1b[41m"];
  let seed = 12345;
  const rand = (n: number) => {
    // Deterministic, so a failure is reproducible rather than a one-off.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const frame = () => {
    const rows: string[] = [];
    for (let y = 0; y < 5; y++) {
      let row = "";
      for (let x = 0; x < 12; x++) {
        if (rand(4) === 0) row += styles[rand(styles.length)]!;
        row += alphabet[rand(alphabet.length)]!;
      }
      rows.push(row);
    }
    return rows.join("\n");
  };

  for (let i = 0; i < 200; i++) {
    const before = frame();
    const after = frame();
    const a = screenOf(before);
    const b = screenOf(after);
    const escape = paint(a, b);
    parseFrame(a, escape);
    assert.equal(
      snapshot(a),
      snapshot(b),
      `soak iteration ${i} diverged.\nbefore: ${JSON.stringify(before)}\nafter: ${JSON.stringify(after)}\nescape: ${JSON.stringify(escape)}`,
    );
  }
});
