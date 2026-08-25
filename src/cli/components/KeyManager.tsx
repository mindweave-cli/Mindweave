/**
 * KeyManager.tsx — what /key shows: the keys you have, and what you can do to them.
 *
 * A FOOTER OVERLAY, not a screen. It sits where the prompt sits, the conversation stays
 * visible above it, and it is only as tall as it needs to be. The first version took the
 * whole terminal for a list of three keys, which is the wrong weight for "change a
 * setting" and left nothing on screen to come back to.
 *
 * Three views in one box. The LIST is every stored key across every provider with the
 * live one marked; choosing one opens its ACTIONS (show, use, replace, remove); "Add a
 * key" picks a provider and takes the value. Everything returns to the list, so managing
 * several keys is one place you stay rather than a command you keep re-running.
 *
 * Esc always goes back one step, INCLUDING while typing a key. A text field that traps
 * you is the thing people notice first, and "empty Enter goes back" is a rule nobody
 * should have to learn.
 */
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { stripMouse } from "../mouse.js";
import { useState, type ReactNode } from "react";
import type { KeyManagerView, KeyRow } from "../keyManager.js";
import { actionsFor } from "../keyManager.js";

/** Rows visible at once. The footer is height-bounded; this is not a screen. */
const WINDOW = 7;

type Mode =
  | { kind: "list" }
  | { kind: "actions"; row: KeyRow }
  | { kind: "pickProvider" }
  | { kind: "enter"; label: string; apiKeyEnv: string; slot: number; replacing: boolean };

export interface KeyManagerProps {
  view: KeyManagerView;
  /** The full value of a key, revealed only when the user asks for it. */
  reveal: (row: KeyRow) => string;
  width: number;
  onUse: (row: KeyRow) => void;
  onSave: (apiKeyEnv: string, slot: number, key: string) => void;
  onRemove: (row: KeyRow) => void;
  onClose: () => void;
  active?: boolean;
}

export function KeyManager({ view, reveal, width, onUse, onSave, onRemove, onClose, active = true }: KeyManagerProps) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [sel, setSel] = useState(0);
  const [value, setValue] = useState("");
  /** Which key is currently shown in full, cleared whenever the view changes. */
  const [shown, setShown] = useState<string | null>(null);

  const addIndex = view.rows.length;
  const targets = pickTargets(view);
  const actions = mode.kind === "actions" ? actionsFor(mode.row, siblings(view, mode.row)) : [];

  const count =
    mode.kind === "list" ? view.rows.length + 1 : mode.kind === "actions" ? actions.length : mode.kind === "pickProvider" ? targets.length : 0;

  function back() {
    setShown(null);
    setValue("");
    if (mode.kind === "list") onClose();
    else {
      setMode({ kind: "list" });
      setSel(0);
    }
  }

  // Escape is handled even while the text field owns the keyboard, because a field you
  // cannot leave is the first thing anyone runs into.
  useInput(
    (input, key) => {
      if (key.escape) return back();
      if (mode.kind === "enter" || count === 0) return;
      if (key.upArrow) setSel((s) => (s - 1 + count) % count);
      else if (key.downArrow) setSel((s) => (s + 1) % count);
      else if (key.return) commit(sel);
      else {
        // One keypress commits, so only single digits ever arrive here.
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, count)) commit(n - 1);
      }
    },
    { isActive: active },
  );

  function commit(index: number) {
    setShown(null);
    if (mode.kind === "list") {
      if (index === addIndex) {
        setSel(0);
        return setMode({ kind: "pickProvider" });
      }
      const row = view.rows[index];
      if (row) {
        setSel(0);
        setMode({ kind: "actions", row });
      }
      return;
    }
    if (mode.kind === "actions") {
      const chosen = actions[index] ?? "Back";
      if (chosen === "Show the key") return setShown(reveal(mode.row));
      setSel(0);
      if (chosen === "Use this key") onUse(mode.row);
      else if (chosen.startsWith("Remove")) onRemove(mode.row);
      else if (chosen === "Replace it") {
        setValue("");
        return setMode({
          kind: "enter",
          label: mode.row.label,
          apiKeyEnv: mode.row.apiKeyEnv,
          slot: mode.row.slot,
          replacing: true,
        });
      }
      return setMode({ kind: "list" });
    }
    if (mode.kind === "pickProvider") {
      const target = targets[index];
      if (!target) return;
      setValue("");
      setMode({ kind: "enter", label: target.label, apiKeyEnv: target.apiKeyEnv, slot: target.slot, replacing: false });
    }
  }

  if (mode.kind === "enter") {
    return (
      <Panel width={width} title={`${mode.replacing ? "Replace" : "Add"} a ${mode.label} key`}>
        <Box flexShrink={0}>
          <Text bold color="cyan">{"  key "}</Text>
          <TextInput
            value={value}
            // Mouse reports arrive at a focused field as TYPED TEXT once wheel reporting is
            // on, so scrolling while pasting a key fills it with escape sequences and the
            // key fails in a way that looks like the key itself is wrong. The prompt has
            // stripped these for a long time; these fields are new and did not.
            onChange={(v) => setValue(stripMouse(v))}
            onSubmit={(v) => {
              const key = v.trim();
              if (key) onSave(mode.apiKeyEnv, mode.slot, key);
              setValue("");
              setMode({ kind: "list" });
              setSel(0);
            }}
            placeholder="paste, then press Enter"
            mask="*"
          />
        </Box>
        <Hint>Enter to save · Esc to go back</Hint>
      </Panel>
    );
  }

  if (mode.kind === "actions") {
    return (
      <Panel
        width={width}
        title={`${mode.row.label} key ${mode.row.slot}  ${mode.row.hint}${mode.row.live ? "   ● in use" : ""}`}
      >
        {actions.map((a, i) => (
          <Row key={a} on={i === sel} n={i + 1} left={a} width={width} />
        ))}
        {shown ? (
          <Box flexShrink={0} marginTop={1}>
            <Text color="yellow" wrap="truncate-end">{`  ${shown}`}</Text>
          </Box>
        ) : null}
        <Hint>{shown ? "shown until you leave this key · Esc to go back" : "↑/↓ · Enter to choose · Esc to go back"}</Hint>
      </Panel>
    );
  }

  if (mode.kind === "pickProvider") {
    const start = windowStart(sel, targets.length);
    return (
      <Panel width={width} title="Which provider is this key for?">
        {targets.slice(start, start + WINDOW).map((t, i) => (
          <Row
            key={`${t.apiKeyEnv}-${t.slot}`}
            on={start + i === sel}
            n={start + i + 1}
            left={t.label}
            right={t.slot > 1 ? `key ${t.slot}` : "first key"}
            width={width}
          />
        ))}
        <Hint>{more(start, targets.length)}↑/↓ · Enter to choose · Esc to go back</Hint>
      </Panel>
    );
  }

  const start = windowStart(sel, view.rows.length + 1);
  return (
    <Panel width={width} title={view.rows.length === 0 ? "Keys — none yet" : "Keys"}>
      {view.rows.slice(start, start + WINDOW).map((r, i) => (
        <Row
          key={`${r.apiKeyEnv}-${r.slot}`}
          on={start + i === sel}
          n={start + i + 1}
          left={r.label}
          mid={r.hint}
          right={r.live ? "● in use" : ""}
          rightColor={r.live ? "green" : undefined}
          width={width}
        />
      ))}
      {start + WINDOW > view.rows.length ? (
        <Row on={sel === addIndex} n={addIndex + 1} left="Add a key" width={width} />
      ) : null}
      <Hint>{more(start, view.rows.length)}↑/↓ · Enter to choose · Esc to close</Hint>
    </Panel>
  );
}

/** "… 4 more · " when the window is hiding rows, so nothing is silently off the bottom. */
function more(start: number, total: number): string {
  const hidden = total - start - WINDOW;
  return hidden > 0 ? `… ${hidden} more · ` : "";
}

function siblings(view: KeyManagerView, row: KeyRow): number {
  return view.rows.filter((r) => r.apiKeyEnv === row.apiKeyEnv).length;
}

/** Where a new key could go: every provider with none, then every provider with room. */
function pickTargets(view: KeyManagerView): { label: string; apiKeyEnv: string; slot: number }[] {
  const fresh = view.emptyProviders.map((p) => ({ label: p.label, apiKeyEnv: p.apiKeyEnv, slot: 1 }));
  const more = new Map<string, { label: string; apiKeyEnv: string; slot: number }>();
  for (const r of view.rows) {
    if (!r.canAddMore) continue;
    const seen = more.get(r.apiKeyEnv);
    more.set(r.apiKeyEnv, { label: r.label, apiKeyEnv: r.apiKeyEnv, slot: Math.max(seen?.slot ?? 0, r.slot + 1) });
  }
  return [...more.values(), ...fresh];
}

/** Scroll the window so the selection stays inside it. */
export function windowStart(sel: number, rowCount: number, size = WINDOW): number {
  if (rowCount <= size) return 0;
  const half = Math.floor(size / 2);
  return Math.max(0, Math.min(sel - half, rowCount - size));
}

/**
 * The bordered box the whole thing lives in.
 *
 * Same shape as the permission prompt: a single grey border, one padding column, and
 * `flexShrink={0}` on every row — without it Yoga compresses an overfull box instead of
 * leaving it at its real height, and the height is what the footer measurement depends on.
 */
function Panel({ width, title, children }: { width: number; title: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Box flexShrink={0}>
        <Text bold wrap="truncate-end">{title}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text> </Text>
      </Box>
      {children}
    </Box>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <Box flexShrink={0} marginTop={1}>
      <Text dimColor wrap="truncate-end">{children}</Text>
    </Box>
  );
}

/**
 * One row. `mid` is a second COLUMN rather than more text in `left`, because a hint
 * appended to a provider name moves with the length of the name — "DeepSeek …a4f2" and
 * "Gemini …77de" then put their markers in different places and the list stops reading
 * as a table.
 */
function Row({
  on,
  n,
  left,
  mid,
  right,
  rightColor,
  width,
}: {
  on: boolean;
  n: number;
  left: string;
  mid?: string;
  right?: string;
  rightColor?: string;
  width: number;
}) {
  const inner = Math.max(12, width - 4);
  return (
    <Box flexShrink={0} width={inner}>
      <Text color={on ? "cyan" : undefined} bold={on}>
        {on ? " › " : "   "}
        {`${n}  `}
      </Text>
      <Box width={mid === undefined ? 22 : 12}>
        <Text color={on ? "cyan" : undefined} bold={on} wrap="truncate-end">{left}</Text>
      </Box>
      {mid === undefined ? null : (
        <Box width={9}>
          <Text dimColor wrap="truncate-end">{mid}</Text>
        </Box>
      )}
      {right ? <Text color={rightColor} dimColor={!rightColor}>{right}</Text> : null}
    </Box>
  );
}
