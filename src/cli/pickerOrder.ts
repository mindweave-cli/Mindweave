/**
 * pickerOrder.ts — how the /provider, /key and /model lists are ORDERED on screen.
 *
 * The registry keeps providers and models in a fixed order that decides the default —
 * the first provider's first model is the out-of-the-box choice — so that order must
 * not be reshuffled. The pickers are a separate question. With fourteen providers, the
 * handful you actually hold a key for are scattered down a list you have to scroll to
 * read, and a provider's models arrive in no order a stranger can predict. So the
 * DISPLAY order lives here, and the registry is left to mean what it means.
 *
 * One idea, in two shapes: the row you are most likely to want floats to the top, and
 * everything else is alphabetical so it is found rather than remembered.
 *
 *  - providers: the default first, then the ones you have a key for, then the rest,
 *    each group A→Z.
 *  - models: the provider's own default first, then the rest A→Z.
 *
 * Pure, and meant to be called by BOTH the render and the selection handler of a
 * picker. Those index into the list by position, so an order the handler did not share
 * would select a different row than the one under the cursor.
 */

/** Case-insensitive A→Z, so `GLM` and `Gemini` sort by letters, not by capital. */
function byLabel(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export interface OrderableProvider {
  id: string;
  label: string;
}

/**
 * Providers in display order: the default first, then every provider holding a key,
 * then the rest — each group alphabetical.
 *
 * `hasKey` is injected rather than read here so this stays pure and testable, and so it
 * works for both the manifest list (/provider) and the key-count rows (/key).
 */
export function orderProviders<T extends OrderableProvider>(
  providers: readonly T[],
  hasKey: (provider: T) => boolean,
  defaultId: string,
): T[] {
  const rank = (p: T): number => (p.id === defaultId ? 0 : hasKey(p) ? 1 : 2);
  return [...providers].sort((a, b) => rank(a) - rank(b) || byLabel(a.label, b.label));
}

export interface OrderableModel {
  id: string;
  label: string;
}

/**
 * A provider's models in display order: its default first, the rest alphabetical.
 *
 * The default is taken as the first entry, because the registry states each provider's
 * lineup default-first; pinning by position keeps this from having to know any id.
 */
export function orderModels<T extends OrderableModel>(models: readonly T[]): T[] {
  if (models.length <= 1) return [...models];
  const [first, ...rest] = models;
  return [first!, ...rest.sort((a, b) => byLabel(a.label, b.label))];
}
