/**
 * keyManager.ts — the rows /key shows, as plain data.
 *
 * Three levels, because a provider is not one key. PROVIDERS first, then that provider's
 * KEYS with an "add another" that never runs out, then what can be done to one key. A
 * flat list of every key across every provider was the first attempt and it buried the
 * thing people actually came to do: manage the keys of one provider.
 *
 * Derived here rather than in the view so "how many keys does this provider have",
 * "which one is being sent" and "what can be done to it" are answerable without
 * rendering anything.
 */
import { allProviders } from "../drivers/registry.js";
import { activeSlot, keyHint, keysFor, nextFreeSlot } from "./keyStore.js";

export interface ProviderRow {
  id: string;
  label: string;
  apiKeyEnv: string;
  /** How many keys are stored for it. Zero is shown too — that is how the first is added. */
  count: number;
}

export interface KeyRow {
  label: string;
  apiKeyEnv: string;
  slot: number;
  /** Last four characters — never more. See keyStore.keyHint. */
  hint: string;
  /** The key the drivers are sending for this provider right now. */
  active: boolean;
}

/** Every provider, with how many keys it holds. */
export function providerRows(env: NodeJS.ProcessEnv = process.env): ProviderRow[] {
  return allProviders().map((p) => ({
    id: p.id,
    label: p.label,
    apiKeyEnv: p.apiKeyEnv,
    count: keysFor(p.apiKeyEnv, env).length,
  }));
}

/** One provider's keys, in slot order. */
export function keyRowsFor(provider: ProviderRow, env: NodeJS.ProcessEnv = process.env): KeyRow[] {
  const live = activeSlot(provider.apiKeyEnv, env);
  return keysFor(provider.apiKeyEnv, env).map((k) => ({
    label: provider.label,
    apiKeyEnv: provider.apiKeyEnv,
    slot: k.slot,
    hint: keyHint(k.value),
    active: k.slot === live,
  }));
}

/** Where the next key for this provider would go, or null when it is full. */
export function nextSlotFor(provider: ProviderRow, env: NodeJS.ProcessEnv = process.env): number | null {
  return nextFreeSlot(provider.apiKeyEnv, env);
}

/** How a provider's key count reads on the provider list. */
export function countLabel(count: number): string {
  return count === 0 ? "no key yet" : `${count} key${count === 1 ? "" : "s"}`;
}

export const ACTION_SHOW = "Show the key";
export const ACTION_ACTIVATE = "Make this the active key";
export const ACTION_EDIT = "Edit it";
export const ACTION_REMOVE = "Remove it";
export const ACTION_BACK = "Back";

/**
 * What can be done to one key.
 *
 * "Make this the active key" is left out when it already is — an action that does
 * nothing is worse than an absent one, because the user tries it and learns nothing.
 * Removing a provider's only key IS allowed: it is how a wrong key gets corrected, and
 * the row says what it will cost rather than refusing.
 */
export function actionsFor(row: KeyRow, keysForProvider: number): string[] {
  return [
    ACTION_SHOW,
    ...(row.active ? [] : [ACTION_ACTIVATE]),
    ACTION_EDIT,
    keysForProvider === 1 ? `${ACTION_REMOVE} (the only key)` : ACTION_REMOVE,
    ACTION_BACK,
  ];
}
