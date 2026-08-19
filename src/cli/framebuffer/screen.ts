/**
 * screen.ts — the cell grid, and the colour model that packs into it.
 *
 * This is the memory the whole framebuffer renderer is built on: one entry per
 * character cell on the terminal, held as a STRUCTURE OF ARRAYS rather than an
 * array of cell objects.
 *
 * Why SoA, concretely: a 200x50 terminal is 10,000 cells. As objects that is
 * 10,000 allocations per frame for the garbage collector to walk, and the fields
 * of one cell land wherever the allocator put them. As four flat typed arrays it
 * is four allocations TOTAL, reused for the life of the process, laid out
 * contiguously so the diff loop reads straight down memory. The diff runs over
 * every cell on every frame, so this is the loop whose cache behaviour decides
 * whether the renderer can hit a frame budget. Same layout OpenTUI's Zig core and
 * ratatui's Buffer use, for the same reason.
 *
 * Everything a cell needs is an integer, so comparing two cells is four integer
 * comparisons and no allocation, no string compare, no property lookup.
 *
 * ## The colour encoding
 *
 * A terminal colour is one of four things, and they must round-trip exactly — a
 * cell that was written as 256-palette colour 33 has to be re-emitted as palette
 * 33, not as its RGB approximation, or the diff would rewrite cells that never
 * actually changed. So the encoding is a tagged integer:
 *
 *   0                          default (terminal's own foreground/background)
 *   PALETTE | n                256-colour palette index n (0-255)
 *   RGB     | (r<<16|g<<8|b)   24-bit truecolour
 *
 * The tag lives above the 24 bits of payload, so an entire colour is one Uint32
 * and equality is `===`.
 */

/** Tag marking a packed colour as a 256-colour palette index. */
export const PALETTE = 1 << 25;
/** Tag marking a packed colour as 24-bit RGB. */
export const RGB = 1 << 26;
/** The terminal's own default colour — what a cell has when nothing set it. */
export const DEFAULT_COLOR = 0;

/** Text attributes, as bit flags in one integer. */
export const ATTR = {
  bold: 1 << 0,
  dim: 1 << 1,
  italic: 1 << 2,
  underline: 1 << 3,
  inverse: 1 << 4,
  hidden: 1 << 5,
  strikethrough: 1 << 6,
} as const;

/**
 * A cell holding the RIGHT half of a double-width character.
 *
 * Wide characters (CJK, most emoji) occupy two terminal columns but are a single
 * character. The left cell carries the codepoint; the right carries this marker so
 * that the diff knows the column is spoken for and the painter knows never to emit
 * anything for it — the terminal advances the cursor two columns by itself when it
 * prints the wide character.
 *
 * It is a distinct value rather than a blank because the difference matters: a
 * blank would be legitimately printable and would desynchronise every column after
 * it on that row.
 */
export const WIDE_CONTINUATION = 0xffff_ffff;

/** A grid of terminal cells. */
export class Screen {
  width: number;
  height: number;
  /** Unicode codepoint per cell. 32 (space) is empty; WIDE_CONTINUATION is the
   *  right half of a wide character. */
  chars: Uint32Array;
  /** Packed foreground colour per cell. */
  fg: Uint32Array;
  /** Packed background colour per cell. */
  bg: Uint32Array;
  /** Packed attribute flags per cell. */
  attrs: Uint32Array;

  constructor(width: number, height: number) {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    const n = this.width * this.height;
    this.chars = new Uint32Array(n);
    this.fg = new Uint32Array(n);
    this.bg = new Uint32Array(n);
    this.attrs = new Uint32Array(n);
    this.clear();
  }

  /** Row-major index of a cell. Callers are expected to be in bounds; this is the
   *  hot path and a check here would run millions of times a second. */
  index(x: number, y: number): number {
    return y * this.width + x;
  }

  /** Reset every cell to a default-styled blank. */
  clear(): void {
    this.chars.fill(32);
    this.fg.fill(DEFAULT_COLOR);
    this.bg.fill(DEFAULT_COLOR);
    this.attrs.fill(0);
  }

  /**
   * Resize, discarding contents.
   *
   * Deliberately does NOT preserve the old grid. A resize re-wraps every line, so
   * the previous contents are not a valid picture of the new screen at any size —
   * keeping them would mean diffing against a frame that never existed and leaving
   * stale text on screen. The caller repaints in full instead.
   *
   * Reuses the existing buffers when the cell count is unchanged (a pure rotation,
   * e.g. 80x50 to 50x80), which is the one case where reallocating would be waste.
   */
  resize(width: number, height: number): void {
    const w = Math.max(0, width);
    const h = Math.max(0, height);
    const n = w * h;
    if (n !== this.chars.length) {
      this.chars = new Uint32Array(n);
      this.fg = new Uint32Array(n);
      this.bg = new Uint32Array(n);
      this.attrs = new Uint32Array(n);
    }
    this.width = w;
    this.height = h;
    this.clear();
  }

  /** Copy `other` into this screen. Both must be the same size; the caller resizes
   *  first. `set` on a typed array is a memcpy, which is the point. */
  copyFrom(other: Screen): void {
    if (other.width !== this.width || other.height !== this.height) {
      this.resize(other.width, other.height);
    }
    this.chars.set(other.chars);
    this.fg.set(other.fg);
    this.bg.set(other.bg);
    this.attrs.set(other.attrs);
  }

  /** Whether two cells are identical in every respect — the diff's inner test. */
  sameAs(other: Screen, i: number): boolean {
    return (
      this.chars[i] === other.chars[i] &&
      this.fg[i] === other.fg[i] &&
      this.bg[i] === other.bg[i] &&
      this.attrs[i] === other.attrs[i]
    );
  }
}

/** Pack a 256-colour palette index. */
export function paletteColor(index: number): number {
  return PALETTE | (index & 0xff);
}

/** Pack a 24-bit RGB colour. */
export function rgbColor(r: number, g: number, b: number): number {
  return RGB | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/**
 * The SGR parameters that produce `color` as a foreground (`fg`) or background.
 *
 * Returns the numeric parameters rather than a finished escape string so the
 * painter can join a whole cell's worth — colour, background and attributes — into
 * ONE `\x1b[...m` instead of three. Fewer, longer sequences is measurably less to
 * write than more, shorter ones.
 */
export function colorParams(color: number, fg: boolean): number[] {
  if (color === DEFAULT_COLOR) return [fg ? 39 : 49];
  if (color & RGB) {
    const v = color & 0xff_ffff;
    return [fg ? 38 : 48, 2, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  }
  const index = color & 0xff;
  // The first 16 palette entries have short, universally supported forms. Worth the
  // branch: they are by far the most common colours a TUI actually uses, and the
  // short form is 3-4 bytes against 11 for the indexed form, on every cell that
  // changes colour.
  if (index < 8) return [(fg ? 30 : 40) + index];
  if (index < 16) return [(fg ? 90 : 100) + (index - 8)];
  return [fg ? 38 : 48, 5, index];
}

/** The SGR parameters that turn `attrs` on, assuming a reset state. */
export function attrParams(attrs: number): number[] {
  const out: number[] = [];
  if (attrs & ATTR.bold) out.push(1);
  if (attrs & ATTR.dim) out.push(2);
  if (attrs & ATTR.italic) out.push(3);
  if (attrs & ATTR.underline) out.push(4);
  if (attrs & ATTR.inverse) out.push(7);
  if (attrs & ATTR.hidden) out.push(8);
  if (attrs & ATTR.strikethrough) out.push(9);
  return out;
}
