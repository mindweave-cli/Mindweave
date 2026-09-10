/**
 * selection.test.ts — what a drag covers, and what lands on the clipboard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTR, Screen, WIDE_CONTINUATION, DEFAULT_COLOR, RGB} from "./framebuffer/screen.js";
import { applySelection, isEmpty, normalize, rowSpan, selectionText, ctrlCShouldCopy } from "./selection.js";

/** A grid holding `rows`, padded out to the full width the way a real frame is. */
function gridOf(rows: string[], width = 20): Screen {
  const screen = new Screen(width, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      screen.chars[screen.index(x, y)] = (row.codePointAt(x) ?? 32) as number;
    }
  });
  return screen;
}

const at = (x: number, y: number) => ({ x, y });
const sel = (ax: number, ay: number, fx: number, fy: number) => ({ anchor: at(ax, ay), focus: at(fx, fy) });

test("a drag that never left its cell selects nothing", () => {
  assert.ok(isEmpty(sel(4, 2, 4, 2)));
  assert.ok(!isEmpty(sel(4, 2, 5, 2)));
  assert.equal(selectionText(gridOf(["hello"]), sel(1, 0, 1, 0)), "");
});

test("dragging backwards is the same selection as dragging forwards", () => {
  const forwards = normalize(sel(2, 0, 7, 1));
  const backwards = normalize(sel(7, 1, 2, 0));
  assert.deepEqual(forwards, backwards);
  assert.deepEqual(forwards.start, at(2, 0));
  assert.deepEqual(forwards.end, at(7, 1));
});

test("the character under the pointer is included", () => {
  // Selecting "he" means dragging from h to e, not from h to the cell after e.
  assert.equal(selectionText(gridOf(["hello"]), sel(0, 0, 1, 0)), "he");
});

test("one line selects the span the drag covered", () => {
  assert.equal(selectionText(gridOf(["the quick brown"]), sel(4, 0, 8, 0)), "quick");
});

test("across lines it follows the TEXT, not a rectangle", () => {
  // A rectangular selection would take columns 8-3 of each row, which is nothing.
  const grid = gridOf(["first line", "second line", "third line"]);
  // The last row stops where the drag did, and its trailing blank is trimmed with the
  // rest of the row's padding — there is no way to tell a deliberate trailing space from
  // the padding beside it, and pasting the padding is the worse mistake.
  assert.equal(selectionText(grid, sel(6, 0, 5, 2)), "line\nsecond line\nthird");
});

test("a middle row is taken end to end", () => {
  const grid = gridOf(["ab", "middle", "yz"]);
  assert.deepEqual(rowSpan(sel(1, 0, 0, 2), 1, 20), { from: 0, to: 20 });
});

test("rows outside the drag are not part of it", () => {
  assert.equal(rowSpan(sel(0, 1, 5, 1), 0, 20), null);
  assert.equal(rowSpan(sel(0, 1, 5, 1), 2, 20), null);
});

test("the padding a terminal row is filled with is not copied", () => {
  // Every row is width-padded with blanks; copying them would paste a wall of spaces.
  const grid = gridOf(["short", "also short"], 40);
  const text = selectionText(grid, sel(0, 0, 39, 1));
  assert.equal(text, "short\nalso short");
  assert.ok(!text.includes("  "), "trailing padding came through");
});

test("a blank row inside a selection stays as an empty line", () => {
  const grid = gridOf(["para one", "", "para two"], 20);
  assert.equal(selectionText(grid, sel(0, 0, 7, 2)), "para one\n\npara two");
});

test("a wide character is copied once, not once per column", () => {
  const grid = new Screen(6, 1);
  grid.chars[grid.index(0, 0)] = "漢".codePointAt(0)!;
  grid.chars[grid.index(1, 0)] = WIDE_CONTINUATION;
  grid.chars[grid.index(2, 0)] = "字".codePointAt(0)!;
  grid.chars[grid.index(3, 0)] = WIDE_CONTINUATION;
  assert.equal(selectionText(grid, sel(0, 0, 3, 0)), "漢字");
});

test("highlighting sets inverse on exactly the selected cells", () => {
  const grid = gridOf(["abcdef"], 6);
  applySelection(grid, sel(1, 0, 3, 0));
  const inverted = [...Array(6).keys()].filter((x) => grid.attrs[grid.index(x, 0)]! & ATTR.inverse);
  assert.deepEqual(inverted, [1, 2, 3]);
});

test("highlighting keeps the styling that was already on a cell", () => {
  // The overlay is one bit added to a built frame, never a repaint of it. Losing the
  // colours underneath would make selected text change appearance twice over.
  const grid = gridOf(["abc"], 3);
  grid.attrs[grid.index(0, 0)] = ATTR.bold;
  applySelection(grid, sel(0, 0, 2, 0));
  assert.equal(grid.attrs[grid.index(0, 0)], ATTR.bold | ATTR.inverse);
});

test("an empty or absent selection highlights nothing", () => {
  const grid = gridOf(["abc"], 3);
  applySelection(grid, null);
  applySelection(grid, sel(1, 0, 1, 0));
  assert.equal(grid.attrs.some((a) => a & ATTR.inverse), false);
});

test("a drag past the edge of the screen cannot read outside the grid", () => {
  const grid = gridOf(["abc"], 3);
  assert.doesNotThrow(() => applySelection(grid, sel(-5, -5, 99, 99)));
  assert.equal(selectionText(grid, sel(-5, 0, 99, 0)), "abc");
});

test("a highlight is one flat block, whatever styling it covers", () => {
  // Inverting swaps foreground and background, so `dim` stops applying to the text and
  // starts applying to the block behind it: a dim run came out washed grey while the
  // blanks beside it came out solid, and one selection read as two.
  const grid = gridOf(["dim words here"], 20);
  for (let x = 0; x < 3; x++) grid.attrs[grid.index(x, 0)] = ATTR.dim;
  applySelection(grid, sel(0, 0, 19, 0));
  for (let x = 0; x < 20; x++) {
    const a = grid.attrs[grid.index(x, 0)]!;
    assert.ok(a & ATTR.inverse, `cell ${x} was not highlighted`);
    assert.equal(a & ATTR.dim, 0, `cell ${x} stayed dim, so the block is two shades`);
  }
});

test("a selection normalises every cell to one colour, so red text is not a red block", () => {
  // The reported look: dragging over a red error line and a cyan hint highlighted them as
  // a red block and a cyan block, because inverse swaps each cell's OWN colour in. Resetting
  // fg/bg to the terminal default first makes every selected cell identical — the default,
  // inverted — whatever colour the text was.
  const grid = gridOf(["red cyan def"], 12);
  grid.fg[grid.index(0, 0)] = RGB | 0xff0000; // red
  grid.fg[grid.index(4, 0)] = RGB | 0x00ffff; // cyan
  grid.bg[grid.index(8, 0)] = RGB | 0x004400; // a green block behind 'def'
  applySelection(grid, sel(0, 0, 11, 0));
  for (let x = 0; x < 12; x++) {
    assert.equal(grid.fg[grid.index(x, 0)], DEFAULT_COLOR, `cell ${x} kept a non-default foreground`);
    assert.equal(grid.bg[grid.index(x, 0)], DEFAULT_COLOR, `cell ${x} kept a non-default background`);
    assert.ok(grid.attrs[grid.index(x, 0)]! & ATTR.inverse, `cell ${x} was not highlighted`);
  }
});

test("highlighting still keeps styling that survives inversion", () => {
  // Only `dim` fights with inverse. Bold does not, and dropping it would change the text.
  const grid = gridOf(["bold"], 4);
  grid.attrs[grid.index(0, 0)] = ATTR.bold | ATTR.dim;
  applySelection(grid, sel(0, 0, 3, 0));
  assert.equal(grid.attrs[grid.index(0, 0)], ATTR.bold | ATTR.inverse);
});

// ── Ctrl+C: copy a live selection, quit only when nothing is selected ───────
//
// The app owns the mouse in the full-screen shell, so text is highlighted by dragging
// and Ctrl+C is the reflex to copy it. Quitting on that reflex, right after someone
// selected something to keep, loses both the selection and the session. So a live
// selection turns Ctrl+C into a copy that dismisses the highlight; nothing selected
// quits, so a second press once the highlight is gone still leaves.

test("Ctrl+C copies when there is a real selection", () => {
  const sel = { anchor: { x: 2, y: 1 }, focus: { x: 9, y: 3 } };
  assert.equal(ctrlCShouldCopy(sel), true);
});

test("Ctrl+C quits when nothing is selected", () => {
  assert.equal(ctrlCShouldCopy(null), false, "no selection at all");
  const click = { anchor: { x: 4, y: 2 }, focus: { x: 4, y: 2 } };
  assert.equal(ctrlCShouldCopy(click), false, "an empty selection (a click) is not something to copy");
});

test("a selection one cell wide is still a selection", () => {
  const oneCell = { anchor: { x: 4, y: 2 }, focus: { x: 5, y: 2 } };
  assert.equal(ctrlCShouldCopy(oneCell), true);
});
