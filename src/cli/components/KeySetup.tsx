/**
 * KeySetup.tsx — the first screen a new user sees.
 *
 * Two steps in one place. The LIST shows every provider Mindweave speaks to, with the
 * ones already set up marked, and a Continue row that lights up as soon as one of them
 * is. Choosing a provider opens a single masked field for its key; saving returns to the
 * list, so someone who wants two or five keys just keeps going.
 *
 * It replaced a screen that asked for the DEFAULT provider's key and nothing else, which
 * meant a user holding a key for any of the other twelve had no way in at all.
 *
 * Height matters here as it does in the footer: thirteen providers plus a Continue row
 * plus the header does not fit a short terminal, so the list scrolls around the
 * selection rather than being clipped at the bottom where Continue lives.
 */
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { useInput } from "ink";
import type { SetupRow, SetupView } from "../keySetup.js";

/** Rows visible at once, so the screen fits a small terminal. */
const WINDOW = 9;

export interface KeySetupProps {
  view: SetupView;
  version: string;
  /** Where keys are written, shown so the user knows what is being touched. */
  envPath: string;
  docsUrl: string;
  /** Save a key for this provider, then come back to the list. */
  onSaveKey: (row: SetupRow, key: string) => void;
  /** Leave setup and start chatting. Only offered once something can run. */
  onContinue: () => void;
  /** Only one input owner may be live. */
  active?: boolean;
  /**
   * Esc leaves without changing anything. Offered when the screen was opened DELIBERATELY
   * (/key) and withheld on a first run, where there is no session behind it to go back to
   * and an escape would only be a way to reach an app that cannot answer.
   */
  onCancel?: () => void;
}

export function KeySetup({ view, version, envPath, docsUrl, onSaveKey, onContinue, active = true, onCancel }: KeySetupProps) {
  const [sel, setSel] = useState(() => firstUnset(view));
  const [entering, setEntering] = useState<SetupRow | null>(null);
  const [value, setValue] = useState("");

  // Continue sits after the providers, as one more row, so there is a single list to
  // move through rather than a list plus a separate control with its own key.
  const rowCount = view.rows.length + 1;
  const onContinueRow = sel === view.rows.length;

  useInput(
    (input, key) => {
      if (entering) return; // the field owns the keyboard while it is open
      if (key.escape && onCancel) onCancel();
      else if (key.upArrow) setSel((s) => (s - 1 + rowCount) % rowCount);
      else if (key.downArrow) setSel((s) => (s + 1) % rowCount);
      else if (key.return) choose(sel);
      else {
        // ONE keypress commits, so only single digits can ever arrive here: typing "1"
        // for row 11 picks row 1 before the second key is pressed. The hint below says
        // 1-9 for that reason — it used to advertise the full range, which was a
        // shortcut four providers did not have, Gemini among them.
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, view.rows.length)) choose(n - 1);
      }
    },
    { isActive: active && !entering },
  );

  function choose(index: number) {
    if (index === view.rows.length) {
      // Ignored rather than refused: a row that cannot act yet says so in its own label,
      // and an error for pressing Enter on it would be noise.
      if (view.canContinue) onContinue();
      return;
    }
    const row = view.rows[index];
    if (row) {
      setValue("");
      setEntering(row);
    }
  }

  if (entering) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Header version={version} />
        <Text>
          Paste your <Text bold>{entering.label}</Text> API key:
        </Text>
        <Box marginTop={1}>
          <Text bold color="cyan">{"  key › "}</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={(v) => {
              const key = v.trim();
              // An empty submit is how you back out — there is nothing to save, and
              // needing a separate key for "never mind" on a field is one more thing to
              // explain on the first screen anyone sees.
              if (key) onSaveKey(entering, key);
              setEntering(null);
              setValue("");
            }}
            placeholder="paste, then press Enter  (empty Enter goes back)"
            mask="•"
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Don't have one? Get a key at {entering.keysUrl}</Text>
          <Text dimColor>Saved to {envPath} — on this machine only, sent only to {entering.label}.</Text>
        </Box>
      </Box>
    );
  }

  const start = windowStart(sel, rowCount);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header version={version} />
      <Text>
        {view.readyCount === 0
          ? "Welcome. Add a key for whichever provider you already use — one is enough."
          : // NAMED, not counted. The list scrolls, so a provider that was just set up is
            // often off-screen with its tick, and "1 provider ready" answers a question
            // nobody asked while leaving the obvious one — which? — unanswered.
            `Ready: ${view.rows.filter((r) => r.ready).map((r) => r.label).join(", ")}. Add more, or continue.`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {view.rows.slice(start, start + WINDOW).map((row, i) => {
          const index = start + i;
          const on = index === sel;
          return (
            <Box key={row.id}>
              <Text color={on ? "cyan" : undefined} bold={on}>
                {on ? " › " : "   "}
                {`${String(index + 1).padStart(2)}  `}
              </Text>
              <Box width={16}>
                <Text color={on ? "cyan" : undefined} bold={on} wrap="truncate-end">{row.label}</Text>
              </Box>
              <Text color={row.ready ? "green" : undefined} dimColor={!row.ready}>
                {row.ready ? "✓ key added" : row.envVar}
              </Text>
            </Box>
          );
        })}
        {start + WINDOW < view.rows.length ? (
          <Text dimColor>{`   … ${view.rows.length - start - WINDOW} more below`}</Text>
        ) : null}
        <Box marginTop={1}>
          <Text color={onContinueRow ? "cyan" : undefined} bold={onContinueRow} dimColor={!view.canContinue}>
            {onContinueRow ? " › " : "   "}
            {view.canContinue ? "Continue →  start chatting" : "Continue →  (add a key first)"}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          ↑/↓ to move · 1-{Math.min(9, view.rows.length)} to jump · Enter to choose
          {onCancel ? " · Esc to leave" : ""}
        </Text>
        <Text dimColor>Keys are saved to {envPath}, on this machine only. Learn more: {docsUrl}</Text>
      </Box>
    </Box>
  );
}

function Header({ version }: { version: string }) {
  return (
    <Box marginBottom={1}>
      <Text bold color="yellow">Mindweave</Text>
      <Text dimColor>{version}</Text>
    </Box>
  );
}

/** Land on the first provider without a key — see keySetup.initialRow. */
function firstUnset(view: SetupView): number {
  const next = view.rows.findIndex((r) => !r.ready);
  return next === -1 ? 0 : next;
}

/** Scroll the window so the selection stays inside it. */
export function windowStart(sel: number, rowCount: number, size = WINDOW): number {
  if (rowCount <= size) return 0;
  const half = Math.floor(size / 2);
  return Math.max(0, Math.min(sel - half, rowCount - 1 - size));
}
