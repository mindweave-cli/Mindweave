/**
 * keyStore.ts — more than one key per provider.
 *
 * A provider is not one credential. People hold a work key and a personal one, a free
 * key that rate-limits and a paid one that does not, a key with credit and one that ran
 * out. Mindweave held exactly one per provider, so the answer to "this key stopped
 * answering" was to go and edit a file.
 *
 * TWO ROLES, TWO VARIABLES, and they must not be the same one. Keys are STORED as
 * `DEEPSEEK_API_KEY_1`, `_2`, `_3`; the bare `DEEPSEEK_API_KEY` is the one currently
 * LIVE, which is what every driver reads. Every driver therefore stays unchanged, and
 * the file stays something a person can open and edit.
 *
 * The first attempt used the bare name as both slot 1 and the live key, which reads
 * neatly and destroys data: switching to key 3 overwrote the variable that WAS key 1, so
 * key 1 was gone and removing another key duplicated key 3 into its place. Found by
 * exercising add → use → remove and reading the file back, not by reading the code.
 *
 * A bare variable with no numbered ones is still honoured as slot 1 — that is how an
 * existing config, or a key exported in the shell, keeps working — and it is normalised
 * into `_1` the first time anything is written.
 */

/** How many keys one provider may hold. Past this the list stops being a list. */
export const MAX_SLOTS = 9;

/** The variable a slot is STORED under. Never the bare name — that one is the live key. */
export function slotVar(apiKeyEnv: string, slot: number): string {
  return `${apiKeyEnv}_${slot}`;
}

export interface StoredKey {
  slot: number;
  envVar: string;
  value: string;
}

/** Every key stored for a provider, in slot order, skipping empty slots. */
export function keysFor(apiKeyEnv: string, env: NodeJS.ProcessEnv = process.env): StoredKey[] {
  const out: StoredKey[] = [];
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const envVar = slotVar(apiKeyEnv, slot);
    const value = env[envVar]?.trim();
    if (value) out.push({ slot, envVar, value });
  }
  // An existing config, or a shell export, has only the bare variable. It counts as the
  // one stored key so nothing a user already had disappears from the list.
  if (out.length === 0) {
    const legacy = env[apiKeyEnv]?.trim();
    if (legacy) return [{ slot: 1, envVar: slotVar(apiKeyEnv, 1), value: legacy }];
  }
  return out;
}

/** The next free slot, or null when the provider is full. */
export function nextFreeSlot(apiKeyEnv: string, env: NodeJS.ProcessEnv = process.env): number | null {
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    if (!env[slotVar(apiKeyEnv, slot)]?.trim()) return slot;
  }
  return null;
}

/**
 * A key's last four characters, for telling two of them apart on screen.
 *
 * Never the whole key, and never the FIRST characters: a provider prefix like `sk-ant-`
 * is identical across a user's keys, so it would distinguish nothing while still putting
 * part of a credential on a screen someone might be sharing.
 */
export function keyHint(value: string): string {
  const tail = value.trim().slice(-4);
  return tail ? `…${tail}` : "";
}

/** Which stored key the drivers are actually sending, or null when none is live. */
export function activeSlot(apiKeyEnv: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const live = env[apiKeyEnv]?.trim();
  if (!live) return null;
  return keysFor(apiKeyEnv, env).find((k) => k.value === live)?.slot ?? null;
}
