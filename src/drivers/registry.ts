/**
 * registry.ts — the one place that knows which providers exist.
 *
 * Every other core module reads the driver through `activeDriver()` and never
 * names a provider. That is what keeps the boundary real: if a second file in
 * `dynamo/` or `cli/` ever imports `drivers/<provider>/` directly, the seam has
 * been broken and it will be obvious here.
 *
 * The split that makes this cheap: each provider's MANIFEST (model list, prices,
 * reasoning levels, context window) is plain data and is always loaded, because
 * the `/model` picker and the cost/compaction math need it before anyone has
 * chosen anything. The provider's DRIVER (wire format, SDK, streaming) is behind
 * a dynamic import and loads only once the user actually selects one of its
 * models. So a DeepSeek user never loads Anthropic's SDK, and adding providers
 * doesn't make any single user's startup heavier.
 *
 * The session picks a driver once, at start, and again when `/model` changes the
 * selection — "compile down to one driver" rather than branching per call.
 */
import type { Driver, DriverManifest, ModelChoice, ModelConfig, ModelId } from "./types.js";
import { deepseekManifest } from "./deepseek/manifest.js";
import { anthropicManifest } from "./anthropic/manifest.js";
import { openaiManifest } from "./openai/manifest.js";
import { qwenManifest } from "./qwen/manifest.js";
import { kimiManifest } from "./kimi/manifest.js";
import { glmManifest } from "./glm/manifest.js";
import { xaiManifest } from "./xai/manifest.js";
import { mistralManifest } from "./mistral/manifest.js";
import { groqManifest } from "./groq/manifest.js";
import { cerebrasManifest } from "./cerebras/manifest.js";

/** Every provider's cheap metadata, in display order. Always loaded. */
const MANIFESTS: DriverManifest[] = [
  deepseekManifest,
  anthropicManifest,
  openaiManifest,
  qwenManifest,
  kimiManifest,
  glmManifest,
  xaiManifest,
  mistralManifest,
  groqManifest,
  cerebrasManifest,
];

/** How to load each provider's wire code, on demand. Keyed by manifest id. */
const LOADERS: Record<string, () => Promise<Driver>> = {
  deepseek: async () => (await import("./deepseek/index.js")).deepseekDriver,
  anthropic: async () => (await import("./anthropic/index.js")).anthropicDriver,
  openai: async () => (await import("./openai/index.js")).openaiDriver,
  qwen: async () => (await import("./qwen/index.js")).qwenDriver,
  kimi: async () => (await import("./kimi/index.js")).kimiDriver,
  glm: async () => (await import("./glm/index.js")).glmDriver,
  xai: async () => (await import("./xai/index.js")).xaiDriver,
  mistral: async () => (await import("./mistral/index.js")).mistralDriver,
  groq: async () => (await import("./groq/index.js")).groqDriver,
  cerebras: async () => (await import("./cerebras/index.js")).cerebrasDriver,
};

/** The provider used when a model id doesn't match any other. */
const FALLBACK = MANIFESTS[0]!;

const loaded = new Map<string, Driver>();
let active: Driver | null = null;

/**
 * Live model lists for DISCOVERED providers, keyed by manifest id.
 *
 * The registry owns this cache rather than each driver, for one reason: a driver
 * that memoized its own would go stale exactly when the user pulls a new model and
 * reopens the picker to find it. Here there is one place to refresh and one place
 * to reason about.
 */
const discovered = new Map<string, ModelChoice[]>();

/**
 * The models a provider currently offers — its discovered list when it has one,
 * its declared list otherwise.
 *
 * Every caller must go through this rather than reading `manifest.models`, or a
 * discovered provider reads as permanently empty. That is the single rule this
 * whole mechanism depends on, and `registry.test.ts` pins it.
 */
export function modelsOf(manifest: DriverManifest): ModelChoice[] {
  return discovered.get(manifest.id) ?? manifest.models;
}

/**
 * The manifest that declares a given model id, or the fallback for an unknown id.
 *
 * Three steps, in order, and the order matters: a provider's real list wins, then a
 * discovered provider's namespace claim, then the fallback. Checking claims last is
 * what stops a provider that claims broadly from stealing a model another provider
 * actually serves.
 */
export function manifestForModel(model: ModelId): DriverManifest {
  return (
    MANIFESTS.find((m) => modelsOf(m).some((c) => c.id === model)) ??
    MANIFESTS.find((m) => m.ownsModel?.(model) === true) ??
    FALLBACK
  );
}

/** Every model offered across all installed providers. */
export function allModels(): ModelChoice[] {
  return MANIFESTS.flatMap((m) => modelsOf(m));
}

/**
 * Refresh the model lists of every discovered provider.
 *
 * Called at session start and before a picker opens, so the list reflects what is
 * actually available now. Providers are refreshed CONCURRENTLY and independently:
 * one local runtime being down must not delay or empty another provider's list.
 *
 * A failure is deliberately silent here and non-destructive — the previous list
 * survives. A provider that cannot be reached is reported where the user can act on
 * it (no key, nothing running), not by a picker that quietly loses its contents.
 * Returns the ids that refreshed successfully, so a caller can tell the difference.
 */
export async function refreshModels(): Promise<string[]> {
  const dynamic = MANIFESTS.filter((m) => m.discoverModels);
  const results = await Promise.all(
    dynamic.map(async (m) => {
      try {
        const models = await m.discoverModels!();
        // An empty result is a real answer — a runtime with nothing pulled — and is
        // stored as such. Failure is the case that must not overwrite.
        discovered.set(m.id, models);
        return m.id;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((id): id is string => id !== null);
}

/** Drop every discovered list. For tests, and for a full provider reset. */
export function clearDiscovered(): void {
  discovered.clear();
}

/**
 * Every installed provider, in display order — what `/provider` lists.
 *
 * Manifests only: this stays synchronous and loads nobody's wire code, so the
 * picker can show every provider without paying to import the ones you don't use.
 */
export function allProviders(): DriverManifest[] {
  return [...MANIFESTS];
}

/**
 * Coerce a config onto something the owning provider actually serves. Pure and
 * synchronous — it consults only manifests, so the pickers can normalize a
 * selection without loading any provider's wire code.
 */
export function normalizeConfig(config: ModelConfig): ModelConfig {
  return manifestForModel(config.model).normalize(config);
}

/**
 * Load the driver that serves `model` and make it the session's active one.
 * Idempotent and cached, so calling it before every turn costs nothing after the
 * first. This is the only place a provider's wire code is ever loaded.
 */
export async function ensureDriver(model: ModelId): Promise<Driver> {
  const id = manifestForModel(model).id;
  let driver = loaded.get(id);
  if (!driver) {
    const load = LOADERS[id];
    if (!load) throw new Error(`No driver registered for provider '${id}'.`);
    driver = await load();
    loaded.set(id, driver);
  }
  active = driver;
  return driver;
}

/**
 * The driver currently serving this session. Callers reach this only from inside
 * a turn, which `ensureDriver` has already opened — a throw here means someone
 * tried to talk to a model before the session selected one.
 */
export function activeDriver(): Driver {
  if (!active) {
    throw new Error("No model driver is loaded yet — the session must select a model first.");
  }
  return active;
}

/**
 * Normalize streamed text for display: let the active driver repair anything its
 * provider leaked into the text channel, then trim. The trim is deliberately here
 * rather than in a driver — a reply that is only whitespace is an empty reply on
 * every provider, and the display layer treats an empty string as "nothing to
 * show". A driver with no repairs to make (or no driver yet) still gets the trim.
 */
export function sanitizeStreamText(raw: string): string {
  const driver = active;
  const repaired = driver?.sanitizeText ? driver.sanitizeText(raw) : raw;
  return repaired.trim();
}
