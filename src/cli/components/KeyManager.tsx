/**
 * KeyManager.tsx — what /key shows.
 *
 * A FOOTER OVERLAY, not a screen: it sits where the prompt sits, the conversation stays
 * visible above it, and it is only as tall as it needs to be. Taking the whole terminal
 * to change a setting is the wrong weight and leaves nothing to come back to.
 *
 * Three levels, drilling in. PROVIDERS, then that provider's KEYS with an "add another"
 * that never runs out, then what can be done to one key. The first version was a flat
 * list of every key across every provider, which buried the thing people came to do.
 *
 * Esc always goes back one level, INCLUDING while typing a key — a field that can only
 * be left by submitting nothing is a trap.
 */
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState, type ReactNode } from "react";
import { stripMouse } from "../mouse.js";
import {
  ACTION_ACTIVATE,
  ACTION_BACK,
  ACTION_EDIT,
  ACTION_REMOVE,
  ACTION_SHOW,
  actionsFor,
  countLabel,
  type KeyRow,
  type ProviderRow,
} from "../keyManager.js";

/** Rows visible at once. The footer is height-bounded; this is not a screen. */
const WINDOW = 7;

type Mode =
  | { kind: "providers" }
  | { kind: "keys"; provider: ProviderRow }
  | { kind: "actions"; provider: ProviderRow; row: KeyRow }
  | { kind: "enter"; provider: ProviderRow; slot: number; replacing: boolean };

export interface KeyManagerProps {
  providers: ProviderRow[];
  /** One provider's keys, read fresh so the list reflects the last edit. */
  keysOf: (provider: ProviderRow) => KeyRow[];
  /** Where the next key would go, or null when the provider is full. */
  nextSlot: (provider: ProviderRow) => number | null;
  /** The full value of a key, only ever called when the user asks to see it. */
  reveal: (row: KeyRow) => string;
  width: number;
  onActivate: (row: KeyRow) => void;
  onSave: (provider: ProviderRow, slot: number, key: string) => void;
  onRemove: (row: KeyRow) => void;
  onClose: () => void;
  active?: boolean;
  /**
   * Open straight on this provider instead of the provider list. Set when the manager is
   * reached by picking a provider that has no key: the pick is already made, so showing
   * the list again and asking for it a second time is the pick wasted.
   */
  startProvider?: ProviderRow | null;
}

export function KeyManager({
  providers,
  keysOf,
  nextSlot,
  reveal,
  width,
  onActivate,
  onSave,
  onRemove,
  onClose,
  active = true,
  startProvider = null,
}: KeyManagerProps) {
  const [mode, setMode] = useState<Mode>(() => {
    // Same drill-in the provider list does on Enter: an empty provider goes straight to
    // the field, one with keys goes to its key list.
    if (startProvider) {
      const slot = nextSlot(startProvider);
      if (startProvider.count === 0 && slot !== null) return { kind: "enter", provider: startProvider, slot, replacing: false };
      return { kind: "keys", provider: startProvider };
    }
    return { kind: "providers" };
  });
  const [sel, setSel] = useState(0);
  const [value, setValue] = useState("");
  const [shown, setShown] = useState<string | null>(null);

  const keys = mode.kind === "keys" || mode.kind === "actions" ? keysOf(mode.provider) : [];
  const actions = mode.kind === "actions" ? actionsFor(mode.row, keys.length) : [];
  // "Add a new key" is one more row after the keys, and it is there however many there
  // already are — that is what makes adding a second, or a fifth, obvious.
  const canAdd = mode.kind === "keys" ? nextSlot(mode.provider) !== null : false;

  const count =
    mode.kind === "providers"
      ? providers.length
      : mode.kind === "keys"
        ? keys.length + (canAdd ? 1 : 0)
        : mode.kind === "actions"
          ? actions.length
          : 0;

  function back() {
    setShown(null);
    setValue("");
    setSel(0);
    if (mode.kind === "providers") onClose();
    else if (mode.kind === "keys") setMode({ kind: "providers" });
    else setMode({ kind: "keys", provider: mode.provider });
  }

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
    if (mode.kind === "providers") {
      const provider = providers[index];
      if (!provider) return;
      setSel(0);
      // A provider with no keys goes straight to the field: there is no list to show, and
      // one more press to reach the only thing you could have wanted is a press wasted.
      const slot = nextSlot(provider);
      if (provider.count === 0 && slot !== null) return setMode({ kind: "enter", provider, slot, replacing: false });
      return setMode({ kind: "keys", provider });
    }
    if (mode.kind === "keys") {
      if (index === keys.length) {
        const slot = nextSlot(mode.provider);
        if (slot === null) return;
        setValue("");
        return setMode({ kind: "enter", provider: mode.provider, slot, replacing: false });
      }
      const row = keys[index];
      if (!row) return;
      setSel(0);
      return setMode({ kind: "actions", provider: mode.provider, row });
    }
    if (mode.kind === "actions") {
      const chosen = actions[index] ?? ACTION_BACK;
      if (chosen === ACTION_SHOW) return setShown(reveal(mode.row));
      if (chosen === ACTION_EDIT) {
        setValue("");
        return setMode({ kind: "enter", provider: mode.provider, slot: mode.row.slot, replacing: true });
      }
      setSel(0);
      if (chosen === ACTION_ACTIVATE) onActivate(mode.row);
      else if (chosen.startsWith(ACTION_REMOVE)) onRemove(mode.row);
      return setMode({ kind: "keys", provider: mode.provider });
    }
  }

  if (mode.kind === "enter") {
    return (
      <Panel
        width={width}
        title={`${mode.replacing ? "Edit the" : "Add a"} ${mode.provider.label} key${mode.replacing ? ` (key ${mode.slot})` : ""}`}
      >
        <Box flexShrink={0}>
          <Text bold color="cyan">{"  key "}</Text>
          <TextInput
            value={value}
            // Mouse reports arrive at a focused field as TYPED TEXT once wheel reporting
            // is on, so scrolling while pasting fills the field with escape sequences and
            // the key fails later in a way that looks like the key itself is wrong.
            onChange={(v) => setValue(stripMouse(v))}
            onSubmit={(v) => {
              const key = v.trim();
              if (key) onSave(mode.provider, mode.slot, key);
              setValue("");
              setSel(0);
              setMode({ kind: "keys", provider: mode.provider });
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
        title={`${mode.provider.label} · key ${mode.row.slot}  ${mode.row.hint}${mode.row.active ? "   ● active" : ""}`}
      >
        {actions.map((a, i) => (
          <Row key={a} on={i === sel} n={i + 1} left={a} width={width} />
        ))}
        {shown ? (
          <Box flexShrink={0} marginTop={1}>
            <Text color="yellow" wrap="truncate-end">{`  ${shown}`}</Text>
          </Box>
        ) : null}
        <Hint>{shown ? "hidden again when you leave · Esc to go back" : "↑/↓ · Enter to choose · Esc to go back"}</Hint>
      </Panel>
    );
  }

  if (mode.kind === "keys") {
    const start = windowStart(sel, count);
    return (
      <Panel width={width} title={`${mode.provider.label} · ${countLabel(keys.length)}`}>
        {keys.slice(start, start + WINDOW).map((r, i) => (
          <Row
            key={r.slot}
            on={start + i === sel}
            n={start + i + 1}
            left={`key ${r.slot}`}
            mid={r.hint}
            right={r.active ? "● active" : ""}
            rightColor={r.active ? "green" : undefined}
            width={width}
          />
        ))}
        {canAdd && start + WINDOW > keys.length ? (
          <Row on={sel === keys.length} n={keys.length + 1} left="Add a new key" width={width} />
        ) : null}
        <Hint>{more(start, keys.length)}↑/↓ · Enter to choose · Esc to go back</Hint>
      </Panel>
    );
  }

  const start = windowStart(sel, providers.length);
  return (
    <Panel width={width} title="Keys">
      {providers.slice(start, start + WINDOW).map((p, i) => (
        <Row
          key={p.id}
          on={start + i === sel}
          n={start + i + 1}
          left={p.label}
          right={countLabel(p.count)}
          rightColor={p.count > 0 ? "green" : undefined}
          width={width}
        />
      ))}
      <Hint>{more(start, providers.length)}↑/↓ · Enter to choose · Esc to close</Hint>
    </Panel>
  );
}

/** "… 4 more · " when the window hides rows, so nothing is silently off the bottom. */
function more(start: number, total: number): string {
  const hidden = total - start - WINDOW;
  return hidden > 0 ? `… ${hidden} more · ` : "";
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
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
    >
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
 * appended to a label moves with the length of the label and the markers then land in
 * different places, so the list stops reading as a table.
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
      <Box width={mid === undefined ? 24 : 10}>
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
