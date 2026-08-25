/**
 * keyManager.ts — the rows /key shows, as plain data.
 *
 * One row per stored key across every provider, then the two things you can do that are
 * not about a key you already have. Derived here rather than in the view so "what is on
 * screen", "which one is live" and "can another be added" are answerable without
 * rendering anything.
 */
import { allProviders } from "../drivers/registry.js";
import { activeSlot, keyHint, keysFor, nextFreeSlot } from "./keyStore.js";

export interface KeyRow {
  /** Which provider this key belongs to. */
  providerId: string;
  label: string;
  apiKeyEnv: string;
  slot: number;
  /** Last four characters — never more. See keyStore.keyHint. */
  hint: string;
  /** The key the drivers are sending for this provider right now. */
  live: boolean;
  /** Whether this provider could hold another key. */
  canAddMore: boolean;
}

export interface KeyManagerView {
  rows: KeyRow[];
  /** Providers with no key at all, offered when adding. */
  emptyProviders: { id: string; label: string; apiKeyEnv: string }[];
}

export function keyManagerView(env: NodeJS.ProcessEnv = process.env): KeyManagerView {
  const rows: KeyRow[] = [];
  const emptyProviders: KeyManagerView["emptyProviders"] = [];
  for (const p of allProviders()) {
    const keys = keysFor(p.apiKeyEnv, env);
    if (keys.length === 0) {
      emptyProviders.push({ id: p.id, label: p.label, apiKeyEnv: p.apiKeyEnv });
      continue;
    }
    const live = activeSlot(p.apiKeyEnv, env);
    const canAddMore = nextFreeSlot(p.apiKeyEnv, env) !== null;
    for (const k of keys) {
      rows.push({
        providerId: p.id,
        label: p.label,
        apiKeyEnv: p.apiKeyEnv,
        slot: k.slot,
        hint: keyHint(k.value),
        live: k.slot === live,
        canAddMore,
      });
    }
  }
  return { rows, emptyProviders };
}

/**
 * What can be done to the key on a row.
 *
 * "Use this key" is left out when it is already the live one — an action that does
 * nothing is worse than an absent one, because the user tries it and learns nothing.
 */
export function actionsFor(row: KeyRow, keysForProvider: number): string[] {
  return [
    // Reading a key back matters when two of them differ by four characters: the hint
    // says WHICH key, and sometimes you need to know it is the right one.
    "Show the key",
    ...(row.live ? [] : ["Use this key"]),
    "Replace it",
    // Removing the only key a provider has is allowed: it is how you correct a mistake
    // in the one you have, and the provider simply stops being available until you add
    // another. Saying so on the row is better than refusing the action.
    keysForProvider === 1 ? "Remove it (this provider's only key)" : "Remove it",
    "Back",
  ];
}
