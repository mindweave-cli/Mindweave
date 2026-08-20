/**
 * resizeCorruption.probe.test.tsx — the screen must not keep pieces of the old frame.
 *
 * Reported from a real session: resizing the terminal left the previous frame's text
 * fused onto the new one. Rows read like `Unknown tool(list_sessions)ns'`, where `ns'`
 * is the tail of the longer line that used to occupy those cells, and whole blocks
 * appeared twice at a one-row offset.
 *
 * The framebuffer only writes cells it believes changed, which is where its ~13x saving
 * comes from, so anything that makes its belief wrong shows up as text that never gets
 * cleaned off. The parser reads a frame's escape sequences to decide where each
 * character lands, and it handles absolute positioning and horizontal movement while
 * skipping every other CSI — including cursor UP/DOWN and the erase sequences a
 * terminal emits when a frame changes height. A frame carrying those is placed at the
 * wrong row, and the row it should have overwritten keeps what it had.
 *
 * This drives the real writer over a real resize and reads what the terminal would end
 * up showing, rather than asserting anything about how the frame is built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { framebufferStdout } from "./writer.js";
import { Screen } from "./screen.js";
import { parseFrame } from "./parse.js";

/** A stdout the writer will treat as a real terminal. */
class FakeTerm extends EventEmitter {
  columns: number;
  rows: number;
  written: string[] = [];
  isTTY = true as const;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
}

/**
 * Replay everything the writer emitted into a fresh grid, which is what the terminal
 * itself does. Reading the writer's OUTPUT rather than its internal grid is the point:
 * a bug that leaves stale cells is invisible from the inside, because the writer's own
 * model is exactly the thing that has gone wrong.
 */
function whatTheTerminalShows(term: FakeTerm): string[] {
  const screen = new Screen(term.columns, term.rows);
  for (const chunk of term.written) parseFrame(screen, chunk);
  const rows: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let row = "";
    for (let x = 0; x < screen.width; x++) {
      const c = screen.chars[y * screen.width + x] ?? 32;
      row += c === 0 ? " " : String.fromCodePoint(c);
    }
    rows.push(row.replace(/\s+$/, ""));
  }
  return rows;
}

/** One frame, as Ink writes it: an erase preamble then the lines. */
function frame(lines: string[]): string {
  return `\x1b[2K\x1b[G${lines.join("\n")}`;
}

test("a shorter line does not leave the tail of the longer one behind", () => {
  const term = new FakeTerm(60, 10);
  const out = framebufferStdout(term as unknown as NodeJS.WriteStream);

  out.write(frame(["unknown tool 'list_sessions'"]));
  out.write(frame(["Unknown tool(list_sessions)"]));

  const rows = whatTheTerminalShows(term);
  assert.equal(
    rows[0],
    "Unknown tool(list_sessions)",
    `stale cells survived: ${JSON.stringify(rows[0])}`,
  );
});

test("a frame that arrives after the terminal shrank does not fuse with the old one", () => {
  // The reported case. The terminal is resized between frames, so the next frame is a
  // different width and a different height, and every cell of the previous one is
  // suspect.
  const term = new FakeTerm(80, 10);
  const out = framebufferStdout(term as unknown as NodeJS.WriteStream);
  out.write(frame(["loaded sessions, ask_user, create_skill, governor, save_memory, workspace"]));

  term.columns = 40;
  term.rows = 8;
  out.write(frame(["Tools(session)"]));

  const rows = whatTheTerminalShows(term);
  assert.equal(rows[0], "Tools(session)", `stale cells survived a resize: ${JSON.stringify(rows[0])}`);
});

test("a block is not drawn twice when the frame changes height", () => {
  // The doubling in the report: the same block on two consecutive rows. That happens
  // when a frame is placed one row below where it should have gone, so it never
  // overwrites its own previous copy.
  const term = new FakeTerm(60, 12);
  const out = framebufferStdout(term as unknown as NodeJS.WriteStream);

  out.write(frame(["> can you try now?", "prompt cache reset"]));
  out.write(frame(["> can you try now?", "prompt cache reset", "Read 1 file"]));

  const rows = whatTheTerminalShows(term).filter((r) => r !== "");
  const prompts = rows.filter((r) => r.includes("can you try now?"));
  assert.equal(prompts.length, 1, `the block was drawn ${prompts.length} times: ${JSON.stringify(rows)}`);
});
