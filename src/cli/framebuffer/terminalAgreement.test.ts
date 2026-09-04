/**
 * terminalAgreement.test.ts — does what the renderer writes actually produce, on a
 * terminal, the screen the renderer thinks it produced?
 *
 * Every other test in this directory checks the renderer against itself. `paint.test.ts`
 * round-trips `parse(paint(a, b))` back to `b`, which proves the two agree with each
 * other; it cannot notice anything they are BOTH wrong about, because the same
 * assumptions sit on both sides of the equation. Overflow was exactly that: `parse`
 * dropped characters past the right margin, `paint` never emitted any, and the round trip
 * was perfectly happy while a real terminal wrapped them onto the next row and pushed
 * every row below it down.
 *
 * So the far side here is a separate, deliberately naive terminal. It knows nothing about
 * `Screen`, cell packing or diffing; it holds a character grid and a cursor and applies
 * bytes the way a VT does. A disagreement between the two is a disagreement with reality
 * rather than between two halves of one idea.
 *
 * Characters and positions only. Colours are covered by the round trip in `paint.test.ts`,
 * and modelling SGR here would mean copying `applySgr` across, which would put this test
 * straight back to grading the renderer's own homework.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Screen, WIDE_CONTINUATION } from "./screen.js";
import { parseFrame } from "./parse.js";
import { paint } from "./paint.js";
import { framebufferStdout, type OutputStream } from "./writer.js";

const ESC = String.fromCharCode(27);
/** Move the cursor, 1-based, the way `paint` does. */
const at = (row: number, col: number) => `${ESC}[${row};${col}H`;

/**
 * A terminal, as far as this test needs one.
 *
 * Autowrap is a constructor option because it is the single behaviour under examination:
 * the app turns it OFF (`altScreen.ts`), and the tests below show both what that buys and
 * what goes wrong without it.
 */
class FakeTerminal {
  private readonly rows: string[][];
  private x = 0;
  private y = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly autowrap = false,
  ) {
    this.rows = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  }

  /** The screen as one string per row, which is what every assertion compares. */
  lines(): string[] {
    return this.rows.map((r) => r.join(""));
  }

  /** Put a character on the screen behind the renderer's back. */
  poke(x: number, y: number, ch: string): void {
    this.rows[y]![x] = ch;
  }

  /** Everything moves up one row and a blank one arrives at the bottom. */
  private scroll(): void {
    this.rows.shift();
    this.rows.push(Array.from({ length: this.width }, () => " "));
  }

  write(data: string): void {
    for (let i = 0; i < data.length; ) {
      const ch = data[i]!;
      if (ch === ESC && data[i + 1] === "[") {
        let j = i + 2;
        while (j < data.length) {
          const c = data.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) break;
          j++;
        }
        const params = data.slice(i + 2, j).split(";");
        const final = data[j];
        if (final === "H") {
          this.y = (Number(params[0]) || 1) - 1;
          this.x = (Number(params[1]) || 1) - 1;
        } else if (final === "J") {
          for (const row of this.rows) row.fill(" ");
        }
        // Styling and everything else changes no character and no position.
        i = j + 1;
        continue;
      }
      if (ch === "\n") {
        // A linefeed on the last row SCROLLS, always. Autowrap governs what happens at
        // the right margin and has no say here, so this must not be conditional on it —
        // a fake that skipped the scroll would let a stray newline look harmless, which
        // is the exact bug this file exists to be able to see.
        this.x = 0;
        if (this.y >= this.height - 1) this.scroll();
        else this.y++;
        i++;
        continue;
      }
      if (ch === "\r") {
        this.x = 0;
        i++;
        continue;
      }
      this.put(ch);
      i++;
    }
  }

  /**
   * Print one character at the cursor.
   *
   * The right margin is the whole point. With autowrap ON the character starts a new row,
   * and the screen scrolls once the last row is full. With it OFF the cursor stays where
   * it is and each further character replaces the one in the final column, which is what
   * a VT does and what `parse.ts` models.
   */
  private put(ch: string): void {
    if (this.x >= this.width) {
      if (this.autowrap) {
        this.x = 0;
        this.y++;
      } else {
        this.x = this.width - 1;
      }
    }
    if (this.y >= this.height) {
      if (!this.autowrap) return;
      this.scroll();
      this.y = this.height - 1;
    }
    if (this.y < 0) return;
    this.rows[this.y]![this.x] = ch;
    this.x++;
  }
}

/** A grid's characters as one string per row, to compare with a terminal's. */
function lines(screen: Screen): string[] {
  const out: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let row = "";
    for (let x = 0; x < screen.width; x++) {
      const c = screen.chars[screen.index(x, y)]!;
      row += c === WIDE_CONTINUATION ? "" : String.fromCodePoint(c === 0 ? 32 : c);
    }
    out.push(row.padEnd(screen.width, " ").slice(0, screen.width));
  }
  return out;
}

/** Build a grid the way the writer does: cleared, then the frame applied. */
function frameToScreen(frame: string, width: number, height: number): Screen {
  const s = new Screen(width, height);
  s.clear();
  parseFrame(s, frame);
  return s;
}

/** A terminal showing exactly what `screen` says, ready to be painted over. */
function seeded(screen: Screen, autowrap = false): FakeTerminal {
  const term = new FakeTerminal(screen.width, screen.height, autowrap);
  const rows = lines(screen);
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) term.poke(x, y, rows[y]![x]!);
  }
  return term;
}

test("what paint writes is what the terminal ends up showing", () => {
  const width = 20;
  const height = 6;
  const before = frameToScreen("hello\nworld", width, height);
  const after = frameToScreen("hello there\nworld\nthird row", width, height);

  const term = seeded(before);
  term.write(paint(before, after, 1));

  assert.deepEqual(term.lines(), lines(after));
});

test("a frame line longer than the screen leaves every other row alone", () => {
  const width = 16;
  const height = 4;
  // The second line overruns by a wide margin; the third has to survive it intact.
  const frame = "top\n" + "x".repeat(width + 9) + "\nbottom";
  const blank = new Screen(width, height);
  const model = frameToScreen(frame, width, height);

  const term = seeded(blank);
  term.write(paint(blank, model, 1));

  assert.deepEqual(term.lines(), lines(model));
  assert.equal(term.lines()[2]!.trimEnd(), "bottom", "the row below an over-long one moved");
});

test("characters past the right margin replace the last column, as a terminal does", () => {
  // Not a detail: `parse.ts` is a model of a terminal, and a terminal with autowrap off
  // overwrites the final column rather than discarding what will not fit. Dropping them
  // instead left the model holding a different character from the one on screen, in the
  // column most likely to be written over.
  const width = 8;
  const model = frameToScreen("a".repeat(width) + "TAIL", width, 2);
  const term = new FakeTerminal(width, 2);
  term.write("a".repeat(width) + "TAIL");

  assert.equal(lines(model)[0], "aaaaaaaL");
  assert.deepEqual(term.lines(), lines(model));
});

test("with autowrap left on, an over-long row drags the rows below it", () => {
  // The red check for the test above, and the reason `altScreen.ts` sends `\x1b[?7l`.
  // The over-long row here is written by something OTHER than paint — the shape this
  // renderer cannot see — and with autowrap on it takes the screen with it.
  const width = 16;
  const height = 4;
  const wrapping = new FakeTerminal(width, height, true);
  const clipping = new FakeTerminal(width, height, false);
  const overlong = at(1, 1) + "x".repeat(width + 5) + at(3, 1) + "bottom";

  wrapping.write(overlong);
  clipping.write(overlong);

  assert.equal(clipping.lines()[1]!.trim(), "", "autowrap off must not touch the next row");
  assert.notEqual(wrapping.lines()[1]!.trim(), "", "autowrap on spills onto the next row");
});

/** A stdout that applies whatever it is given to a terminal. */
function terminalStdout(term: FakeTerminal): OutputStream {
  return {
    columns: term.width,
    rows: term.height,
    write(data: string, callback?: (err?: Error | null) => void): boolean {
      term.write(data);
      callback?.(null);
      return true;
    },
    on() {
      return undefined;
    },
  };
}

/** Run `body` with the repaint interval forced, and put the environment back after. */
function withRepaintInterval(ms: string, body: () => void): void {
  const previous = process.env["MINDWEAVE_FB_REPAINT_MS"];
  process.env["MINDWEAVE_FB_REPAINT_MS"] = ms;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env["MINDWEAVE_FB_REPAINT_MS"];
    else process.env["MINDWEAVE_FB_REPAINT_MS"] = previous;
  }
}

test("a stray newline never reaches the terminal", () => {
  // Seen on screen: the banner half-buried under a tool row, `●MWrite(docs.html)`, with
  // the `M` all that survived of "Mindweave". A newline written at the bottom row scrolls
  // the whole screen up one line, and the model — the only thing that knows what is on
  // screen — is not told, so every row afterwards is painted somewhere it is not.
  //
  // It passed through because the guard trimmed before asking whether anything was left,
  // and a trimmed newline is empty.
  // Four rows, and the frame fills them, so the cursor is left on the last one — which
  // is where a newline does its damage and where the real screen sits during a session.
  const term = new FakeTerminal(20, 4);
  withRepaintInterval(String(60 * 60 * 1000), () => {
    const out = framebufferStdout(terminalStdout(term));
    out.write("alpha\nbeta\ngamma\ndelta");
    const before = term.lines();
    assert.match(before[0]!, /alpha/, "the frame did not land as expected");
    for (const stray of ["\n", "\r\n", "\n\n"]) out.write(stray);
    assert.deepEqual(term.lines(), before, "a bare newline scrolled the screen out from under the model");
  });
});

test("a frame of nothing but spaces is still a frame", () => {
  // The other side of that guard. Trimming would have swallowed this too, and a screen
  // that should have been cleared would keep whatever it had.
  const term = new FakeTerminal(8, 2);
  withRepaintInterval(String(60 * 60 * 1000), () => {
    const out = framebufferStdout(terminalStdout(term));
    out.write("alpha");
    out.write("     ");
    assert.equal(term.lines()[0]!.trim(), "", "the blanking frame was discarded as empty");
  });
});

test("a screen corrupted behind the renderer's back is repaired", () => {
  const term = new FakeTerminal(24, 5);
  withRepaintInterval("0", () => {
    const out = framebufferStdout(terminalStdout(term));
    out.write("alpha\nbeta");
    // Something else writes to the terminal. The renderer has no way to know.
    term.poke(0, 0, "Z");
    term.poke(3, 1, "Z");
    out.write("alpha\nbeta");
    assert.equal(term.lines()[0]!.trimEnd(), "alpha", "the stray character was never rewritten");
    assert.equal(term.lines()[1]!.trimEnd(), "beta");
  });
});

test("without the repair, the same corruption survives every later frame", () => {
  // The red check for the test above: an unchanged frame writes nothing at all, so a cell
  // the model has right and the terminal has wrong stays wrong for as long as the model
  // is believed. This is the failure the repaint exists to bound.
  const term = new FakeTerminal(24, 5);
  withRepaintInterval(String(60 * 60 * 1000), () => {
    const out = framebufferStdout(terminalStdout(term));
    out.write("alpha\nbeta");
    term.poke(0, 0, "Z");
    out.write("alpha\nbeta");
    assert.equal(term.lines()[0]!.trimEnd(), "Zlpha");
  });
});
