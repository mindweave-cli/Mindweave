/**
 * PromptInput — the chat input box, pinned to the bottom of the screen.
 *
 * Owns its buffer + cursor via useInput (Ink does the word-wrapping; the box
 * grows downward). Beyond plain editing it provides the "real tool" niceties:
 *
 *  - Input history: ↑/↓ walk previously sent messages (a draft is preserved).
 *  - Slash autocomplete: typing `/…` opens a menu of matching commands/skills;
 *    ↑/↓ select, Tab completes, Enter runs the highlighted one.
 *  - Multiline: Shift+Enter inserts a newline (where the terminal reports it);
 *    Enter sends.
 *
 * Pinned to the bottom of the alt-screen frame (see App) while the chat scrolls
 * above it. Editing keys: ←/→, Ctrl+A/E (home/end), Ctrl+U (kill line),
 * Backspace, and paste (inserted at the cursor).
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { inputView } from "../inputView.js";
import { feedPasteChunk, initPasteState, type PasteState } from "../pasteAssembler.js";
import { stripMouse } from "../mouse.js";

/** One autocomplete entry. */
export interface Completion {
  name: string; // includes the leading slash, e.g. "/skills"
  description: string;
}

// A paste collapses to a `[Pasted text …]` chip (the full content is restored when
// the message is sent) once it's big enough to flood the box — either many lines OR
// a long chunk that happens to be few lines (e.g. a couple of wrapped paragraphs).
// A single terminal paste always arrives as one `input` chunk, so a chunk this large
// is unambiguously a paste, never typed keys.
const PASTE_MIN_LINES = 6;
const PASTE_MIN_CHARS = 400;
// Bracketed paste: we ask the terminal (via `\x1b[?2004h`) to wrap every paste in
// `\x1b[200~ … \x1b[201~` markers, so we know exactly where a paste starts and ends
// instead of guessing. The chunk-reassembly state machine lives in pasteAssembler.ts
// (pure + unit-tested); here we just drive it and handle the timing fallback.
const BRACKET_PASTE_ON = "\x1b[?2004h";
const BRACKET_PASTE_OFF = "\x1b[?2004l";
// Safety net if the closing marker is lost or split across a chunk boundary: flush a
// marker-started paste after this much silence. Chunks of one paste arrive microseconds
// apart, so this never fires mid-paste.
const PASTE_END_TIMEOUT_MS = 250;
// Fallback for terminals that DON'T support bracketed paste (no markers ever arrive):
// coalesce chunks by timing. An input event this large, or one with a newline, or a
// continuation of one already buffering, is a paste chunk — never a typed key.
const PASTE_COALESCE_MS = 30;
const PASTE_CHUNK_MIN = 40;

/**
 * The whole input buffer in one state object. Ink runs React in LegacyRoot mode, so
 * state updates from `useInput` (a Node stdin `data` listener, outside React's
 * batching scope) are NOT batched — each separate `setState` flushes its own
 * synchronous render and full terminal redraw. Folding every keystroke into ONE
 * reducer dispatch keeps it at one render → one frame per key, which is what makes
 * typing feel instant instead of laggy (especially on Windows, where each redraw is
 * comparatively expensive).
 */
interface InputState {
  value: string;
  cursor: number; // offset into `value`
  histIdx: number | null; // null = editing a fresh draft (not browsing history)
  selected: number; // highlighted suggestion in the menu
  draft: string; // the in-progress line, stashed while browsing history
}

const INITIAL: InputState = { value: "", cursor: 0, histIdx: null, selected: 0, draft: "" };

type Action =
  | { t: "insert"; text: string } // a keypress or pasted chunk at the cursor
  | { t: "backspace" }
  | { t: "left" }
  | { t: "right" }
  | { t: "home" }
  | { t: "end" }
  | { t: "killLine" } // Ctrl+U — delete from start to cursor
  | { t: "newline" } // Shift/Meta+Enter
  | { t: "splice"; start: number; end: number; text: string } // replace a range (path completion)
  | { t: "selUp" }
  | { t: "selDown"; max: number }
  | { t: "histReplace"; value: string; histIdx: number | null; draft?: string }
  | { t: "reset" };

function reduce(s: InputState, a: Action): InputState {
  switch (a.t) {
    case "insert":
      // Typing leaves history-browsing and resets the suggestion highlight.
      return {
        ...s,
        value: s.value.slice(0, s.cursor) + a.text + s.value.slice(s.cursor),
        cursor: s.cursor + a.text.length,
        histIdx: null,
        selected: 0,
      };
    case "backspace":
      if (s.cursor === 0) return s;
      return {
        ...s,
        value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor),
        cursor: s.cursor - 1,
        selected: 0,
      };
    case "left":
      return { ...s, cursor: Math.max(0, s.cursor - 1) };
    case "right":
      return { ...s, cursor: Math.min(s.value.length, s.cursor + 1) };
    case "home":
      return { ...s, cursor: 0 };
    case "end":
      return { ...s, cursor: s.value.length };
    case "killLine":
      return { ...s, value: s.value.slice(s.cursor), cursor: 0 };
    case "newline":
      return {
        ...s,
        value: s.value.slice(0, s.cursor) + "\n" + s.value.slice(s.cursor),
        cursor: s.cursor + 1,
      };
    case "splice": {
      const value = s.value.slice(0, a.start) + a.text + s.value.slice(a.end);
      return { ...s, value, cursor: a.start + a.text.length, selected: 0 };
    }
    case "selUp":
      return { ...s, selected: Math.max(0, s.selected - 1) };
    case "selDown":
      return { ...s, selected: Math.min(a.max, s.selected + 1) };
    case "histReplace":
      return {
        ...s,
        value: a.value,
        cursor: a.value.length,
        histIdx: a.histIdx,
        draft: a.draft ?? s.draft,
      };
    case "reset":
      return INITIAL;
  }
}

interface PromptInputProps {
  /** Called with the trimmed text when the user sends (Enter). */
  onSubmit: (value: string) => void;
  /** When true, the box is shown but input is inert (Mindweave is working). */
  disabled?: boolean;
  placeholder?: string;
  /** Current terminal width — used to bound the field so text wraps cleanly. */
  width: number;
  /** Previously sent messages, oldest-first — walked with ↑/↓. */
  history?: string[];
  /** Slash-command / skill completions offered when the buffer starts with `/`. */
  completions?: Completion[];
  /** Resolve a `@path` prefix to candidate paths (dirs end with `/`). Enables the
   *  file picker that opens while typing an `@mention`. */
  pathComplete?: (prefix: string) => Promise<string[]>;
  /** Register a large multi-line paste; returns the placeholder chip to insert in
   *  its place (the App restores the full text when the message is sent). */
  onLargePaste?: (content: string) => string;
  /** How many command-palette rows App.tsx has actually verified there's room
   *  for — computed from the real frame height, not a guess. Showing more than
   *  this can make the footer taller than the screen, which corrupts the whole
   *  frame rather than just clipping (confirmed with a bare Ink render), so this
   *  is a hard cap, not a suggestion. Falls back to a small, always-safe count. */
  maxMenuRows?: number;
  /** Called when the suggestion menu's size changes (opened, closed, or
   *  filtered to a different number of rows). The App needs this to re-measure
   *  the footer — see the call site for why it can't detect it on its own. */
  onMenuChange?: () => void;
  /** Hard ceiling on how many rows the text area may occupy. Past it the box
   *  scrolls with the cursor instead of growing, because the rows it would take
   *  come off the bottom of a fixed frame — where the tip line lives. */
  maxInputRows?: number;
}

const DEFAULT_MAX_SUGGESTIONS = 6;
/** Rows the text area may grow to before it scrolls instead. Enough for a real
 *  paragraph; small enough that the chat above it is never squeezed away. */
const DEFAULT_MAX_INPUT_ROWS = 8;

export function PromptInput({
  onSubmit,
  disabled = false,
  placeholder = "",
  width,
  history = [],
  completions = [],
  pathComplete,
  onLargePaste,
  maxMenuRows = DEFAULT_MAX_SUGGESTIONS,
  onMenuChange,
  maxInputRows = DEFAULT_MAX_INPUT_ROWS,
}: PromptInputProps) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const { value, cursor, histIdx, selected, draft } = state;

  // The two autocomplete sources. Command menu: a single `/token` (no space) at the
  // start. Path menu: a `@token` ending at the cursor, resolved against the
  // filesystem (async, in the effect below). Command takes priority.
  const commandMode = value.startsWith("/") && !value.includes(" ");
  const at = !commandMode && pathComplete ? atTokenAt(value, cursor) : null;
  const [pathItems, setPathItems] = useState<string[]>([]);
  useEffect(() => {
    if (!at || !pathComplete) {
      setPathItems([]);
      return;
    }
    let cancelled = false;
    pathComplete(at.text.slice(1)).then((items) => {
      if (!cancelled) setPathItems(items);
    });
    return () => {
      cancelled = true;
    };
  }, [at?.text, pathComplete]);

  const menu = computeMenu();
  const menuOpen = menu !== null;
  const sel = Math.min(selected, Math.max(0, (menu?.items.length ?? 1) - 1));

  // Tell the App the footer's height just changed.
  //
  // Opening the menu is state local to THIS component, so React re-renders only
  // this subtree — App does not re-render, so App's own footer measurement never
  // re-runs and it keeps sizing the chat against a menu-closed footer. The menu
  // then overflows the frame and is clipped away entirely; sitting idle at the
  // prompt, nothing else re-renders App, so it never corrects itself. The row
  // count (not just open/closed) is the trigger, because filtering as you type
  // changes the height too.
  const menuRowCount = menu ? Math.min(menu.items.length, maxMenuRows) : 0;
  useEffect(() => {
    onMenuChange?.();
  }, [menuRowCount, onMenuChange]);

  function computeMenu(): { mode: "command" | "path"; items: Completion[]; start: number } | null {
    if (commandMode) {
      const items = completions.filter((c) => c.name.toLowerCase().startsWith(value.toLowerCase()));
      return items.length > 0 ? { mode: "command", items, start: 0 } : null;
    }
    if (at && pathItems.length > 0) {
      return { mode: "path", items: pathItems.map((p) => ({ name: "@" + p, description: "" })), start: at.start };
    }
    return null;
  }

  // Apply the highlighted path completion: splice it over the `@token` (keep the
  // menu open after a directory so you can keep drilling in).
  function completePath() {
    if (!menu || menu.mode !== "path") return;
    const chosen = menu.items[sel]!.name;
    const text = chosen.endsWith("/") ? chosen : chosen + " ";
    dispatch({ t: "splice", start: menu.start, end: cursor, text });
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    dispatch({ t: "reset" });
    onSubmit(trimmed);
  }

  // Paste reassembly: a paste arrives as several `input` chunks. `paste` holds the
  // cross-chunk state (see pasteAssembler.ts); the timer flushes the fallback path and
  // guards against a lost end marker.
  const paste = useRef<PasteState>(initPasteState());
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Insert an assembled paste — as a `[Pasted text …]` chip when it's big enough to
  // flood the box, otherwise inline.
  function emitPaste(text: string) {
    if (!text) return;
    const big = text.split("\n").length >= PASTE_MIN_LINES || text.length >= PASTE_MIN_CHARS;
    dispatch({ t: "insert", text: onLargePaste && big ? onLargePaste(text) : text });
  }
  function flushPaste() {
    pasteTimer.current = null;
    // A split end-marker can leave a stray trailing ESC; drop it.
    const buf = paste.current.buf.replace(/\x1b$/, "");
    paste.current = initPasteState();
    emitPaste(buf);
  }
  // Turn bracketed paste on so the terminal delimits pastes for us; restore it on exit.
  useEffect(() => {
    process.stdout.write(BRACKET_PASTE_ON);
    return () => {
      if (pasteTimer.current) clearTimeout(pasteTimer.current);
      process.stdout.write(BRACKET_PASTE_OFF);
    };
  }, []);

  useInput(
    (raw, key) => {
      // Mouse reports arrive as ordinary stdin bytes once wheel reporting is on
      // (see mouse.ts). Ink's key parser does not recognise them and hands them
      // straight through as if typed, so scrolling filled the prompt with
      // `[<64;25;26M`. Stripped FIRST — ahead of the paste assembler, which would
      // otherwise buffer a fast flick and commit it as a pasted block.
      const input = stripMouse(raw);
      // A chunk that was nothing but mouse reports is not a keystroke. Guarded on
      // `raw` being non-empty so genuine keys that carry no text (arrows, Enter)
      // still reach the handlers below.
      if (input === "" && raw !== "") return;

      // Bracketed paste (authoritative): from the `\x1b[200~` start marker to the
      // `\x1b[201~` end marker, every chunk is literal pasted content — never Enter,
      // arrows, or other keys — so we handle it here, before anything else, accumulating
      // across chunks. The paste flushes as ONE unit (one chip) at the end marker; the
      // timer only guards against a lost/split end marker.
      const step = feedPasteChunk(paste.current, input);
      if (step.kind !== "passthrough") {
        if (pasteTimer.current) clearTimeout(pasteTimer.current);
        if (step.kind === "flush") {
          pasteTimer.current = null;
          paste.current = initPasteState();
          emitPaste(step.text);
        } else {
          paste.current = step.state;
          pasteTimer.current = setTimeout(flushPaste, PASTE_END_TIMEOUT_MS);
        }
        return;
      }

      // Enter: Shift+Enter inserts a newline (terminals that report it); plain
      // Enter sends — the highlighted suggestion when the menu is open, else the
      // buffer.
      if (key.return) {
        if (key.shift || key.meta) {
          dispatch({ t: "newline" });
          return;
        }
        // In the path menu, Enter completes the path (you press Enter again to send);
        // in the command menu it runs the highlighted command; otherwise it sends.
        if (menu?.mode === "path") {
          completePath();
          return;
        }
        submit(menu ? menu.items[sel]!.name : value);
        return;
      }

      // Tab completes the highlighted suggestion (a command, or a path mention).
      // Shift-Tab is reserved for cycling the interaction mode (handled in App), so
      // it must never complete here.
      if (key.tab && !key.shift && menu) {
        if (menu.mode === "path") completePath();
        else dispatch({ t: "histReplace", value: menu.items[sel]!.name + " ", histIdx: null });
        return;
      }

      // ↑/↓: navigate the menu when open, otherwise walk input history.
      if (key.upArrow) {
        if (menuOpen) dispatch({ t: "selUp" });
        else historyPrev();
        return;
      }
      if (key.downArrow) {
        if (menuOpen) dispatch({ t: "selDown", max: menu!.items.length - 1 });
        else historyNext();
        return;
      }

      if (key.backspace || key.delete) {
        dispatch({ t: "backspace" });
        return;
      }
      if (key.leftArrow) {
        dispatch({ t: "left" });
        return;
      }
      if (key.rightArrow) {
        dispatch({ t: "right" });
        return;
      }
      if (key.ctrl && input === "a") {
        dispatch({ t: "home" });
        return;
      }
      if (key.ctrl && input === "e") {
        dispatch({ t: "end" });
        return;
      }
      if (key.ctrl && input === "u") {
        dispatch({ t: "killLine" });
        return;
      }

      // Ignore control chords / keys we don't handle here (Esc is App's interrupt).
      if (key.ctrl || key.meta || key.escape || key.tab) {
        return;
      }

      // Printable text. On terminals WITHOUT bracketed paste (no markers ever arrive),
      // we fall back to timing: a large chunk, a chunk with a newline, or a continuation
      // of one already buffering is a paste — accumulate and flush once idle so the whole
      // paste is one decision (one chip). A lone keypress inserts immediately.
      if (input) {
        const isPasteChunk =
          paste.current.buf.length > 0 || input.length >= PASTE_CHUNK_MIN || input.includes("\n");
        if (isPasteChunk) {
          paste.current.buf += input;
          if (pasteTimer.current) clearTimeout(pasteTimer.current);
          pasteTimer.current = setTimeout(flushPaste, PASTE_COALESCE_MS);
        } else {
          dispatch({ t: "insert", text: input });
        }
      }

      function historyPrev() {
        if (history.length === 0) return;
        if (histIdx === null) {
          const i = history.length - 1;
          dispatch({ t: "histReplace", value: history[i]!, histIdx: i, draft: value });
        } else if (histIdx > 0) {
          dispatch({ t: "histReplace", value: history[histIdx - 1]!, histIdx: histIdx - 1 });
        }
      }
      function historyNext() {
        if (histIdx === null) return;
        const i = histIdx + 1;
        if (i >= history.length) {
          dispatch({ t: "histReplace", value: draft, histIdx: null });
        } else {
          dispatch({ t: "histReplace", value: history[i]!, histIdx: i });
        }
      }
    },
    { isActive: !disabled },
  );

  const fieldWidth = Math.max(10, width - 6);

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box
        flexDirection="column"
        width={width}
        flexShrink={0}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
      >
        <Field
          value={value}
          cursor={cursor}
          active={!disabled}
          placeholder={placeholder}
          width={fieldWidth}
          maxRows={maxInputRows}
        />
      </Box>

      {menu ? <SuggestionMenu matches={menu.items} selected={sel} width={width} mode={menu.mode} maxRows={maxMenuRows} /> : null}
    </Box>
  );
}

/** The `@token` ending at the cursor (back to the nearest whitespace), or null.
 *  Used to drive the file-path picker while typing a `@mention`. */
// No real @mention (a path) is anywhere near this long. Without a cap, a run of
// the same non-whitespace character (fast typing, a held key) has no whitespace
// to stop the scan at, so it walks back to index 0 on EVERY keystroke — O(cursor)
// work repeated once per character typed, which is what made fast typing laggy
// even well under the length where Field's own render-windowing kicks in.
const MAX_TOKEN_SCAN = 300;

function atTokenAt(value: string, cursor: number): { text: string; start: number } | null {
  const floor = Math.max(0, cursor - MAX_TOKEN_SCAN);
  let i = cursor;
  while (i > floor && !/\s/.test(value[i - 1]!)) i--;
  if (i === floor && floor > 0 && !/\s/.test(value[floor - 1] ?? " ")) return null; // ran into the cap, not a real boundary
  const text = value.slice(i, cursor);
  return text.startsWith("@") ? { text, start: i } : null;
}

/**
 * The dropdown of matching commands/skills shown below the input. It SCROLLS: a
 * sliding window keeps the highlighted row in view as ↑/↓ move past the visible
 * count, with `↑ N more` / `↓ N more` markers for what's hidden above/below — so a
 * long list (every command) is fully reachable, not capped at the first few.
 *
 * Bordered like the input box itself, not a bare list floating under it — same
 * treatment, same reason: it's the other place the user is choosing something,
 * not just reading a log.
 */
function SuggestionMenu({
  matches,
  selected,
  width,
  mode,
  maxRows,
}: {
  matches: Completion[];
  selected: number;
  width: number;
  mode: "command" | "path";
  maxRows: number;
}) {
  // Window the list so `selected` is always visible (same scheme as Picker).
  const start = Math.min(Math.max(0, selected - (maxRows - 1)), Math.max(0, matches.length - maxRows));
  const shown = matches.slice(start, start + maxRows);
  const nameWidth = Math.min(18, Math.max(...shown.map((m) => m.name.length), 1));
  const above = start;
  const below = matches.length - (start + shown.length);
  const title = mode === "command" ? "Commands" : "Files";
  // The prefix ("› " / "  ") + the padded name, so the description column knows
  // exactly what's left. Without this Box the description had no width of its
  // own to truncate against — Yoga let a long one push past the row and wrap,
  // splitting a command's NAME onto its own line, one row later than where it
  // belonged. Confirmed with a bare Ink render before this fix went in.
  const descWidth = Math.max(4, width - 2 - 2 - nameWidth);
  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      {/* flexShrink:0 on every row here (not just the menu's own outer box) is
          what makes App.tsx's maxRows cap actually reliable: without it, Yoga
          can compress an overfull menu instead of respecting the cap that was
          computed specifically so it wouldn't need to — confirmed the same way
          the chat viewport's own flexShrink:0 rows were (see App.tsx). */}
      {/* The parenthetical is the only place that says you can keep TYPING to narrow the
          list. Without it the arrows look like the only way through, and a long catalog
          reads as something to scroll rather than something to filter. */}
      <Box flexShrink={0}>
        <Text bold>{title}</Text>
        <Text dimColor>{" (type to filter, or use ↑/↓)"}</Text>
      </Box>
      {above > 0 ? <Box flexShrink={0}><Text dimColor>{`  ↑ ${above} more`}</Text></Box> : null}
      {shown.map((m, i) => {
        const active = start + i === selected;
        return (
          <Box key={m.name} width={width - 2} flexShrink={0}>
            <Text color={active ? "cyan" : undefined} bold={active}>
              {active ? "› " : "  "}
              {m.name.padEnd(nameWidth)}
            </Text>
            <Box width={descWidth}>
              <Text dimColor wrap="truncate-end">{"  " + m.description}</Text>
            </Box>
          </Box>
        );
      })}
      {below > 0 ? <Box flexShrink={0}><Text dimColor>{`  ↓ ${below} more`}</Text></Box> : null}
      <Box flexShrink={0}>
        <Text dimColor>{mode === "command" ? "Tab completes · Esc dismisses" : "↑/↓ to select · Enter/Tab to complete · Esc dismisses"}</Text>
      </Box>
    </Box>
  );
}

/** The text area: the buffer word-wrapped, with a block cursor, or a placeholder. */
/**
 * The text area: the buffer wrapped into rows with a block cursor, capped in height.
 *
 * Row-by-row rather than one `<Text wrap="wrap">`, because the box has to know how tall
 * it is. Left to wrap itself it grew without limit, and since it shares a fixed frame
 * with the chat and the tip line, the rows it took came off the bottom of the screen —
 * the tip vanished and the box looked cut in half. The wrapping and the cursor maths
 * live in inputView.ts, where they are unit-tested.
 */
function Field({
  value,
  cursor,
  active,
  placeholder,
  width,
  maxRows,
}: {
  value: string;
  cursor: number;
  active: boolean;
  placeholder: string;
  width: number;
  maxRows: number;
}) {
  if (value.length === 0) {
    return (
      <Box flexShrink={0}>
        <Text bold color="cyan">{"> "}</Text>
        <Box width={width} overflow="hidden">
          <Text wrap="truncate-end">
            {active ? <Text inverse> </Text> : null}
            {placeholder ? <Text dimColor>{placeholder}</Text> : null}
          </Text>
        </Box>
      </Box>
    );
  }

  const view = inputView(value, cursor, width, maxRows);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {view.hiddenAbove > 0 ? (
        <Box flexShrink={0}><Text dimColor>{`  ↑ ${view.hiddenAbove} more line${view.hiddenAbove === 1 ? "" : "s"}`}</Text></Box>
      ) : null}
      {view.rows.map((row, i) => (
        <Box key={i} flexShrink={0}>
          {/* The marker is only on the first row; continuations align under the text
              so a wrapped message reads as one paragraph, not a list. */}
          <Text bold color="cyan">{i === 0 && view.hiddenAbove === 0 ? "> " : "  "}</Text>
          <Box width={width} overflow="hidden">
            <Text wrap="truncate-end">
              {active && i === view.cursorRow ? (
                <>
                  {row.text.slice(0, view.cursorCol)}
                  <Text inverse>{row.text.slice(view.cursorCol, view.cursorCol + 1) || " "}</Text>
                  {row.text.slice(view.cursorCol + 1)}
                </>
              ) : (
                row.text
              )}
            </Text>
          </Box>
        </Box>
      ))}
      {view.hiddenBelow > 0 ? (
        <Box flexShrink={0}><Text dimColor>{`  ↓ ${view.hiddenBelow} more line${view.hiddenBelow === 1 ? "" : "s"}`}</Text></Box>
      ) : null}
    </Box>
  );
}

