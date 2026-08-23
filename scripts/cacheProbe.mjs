/**
 * cacheProbe.mjs — does this model actually serve our prompt from cache?
 *
 * Answers one question with a number instead of a theory: across a run of calls that
 * share an identical prefix, how many prompt tokens does the provider report as cache
 * hits? A model that never reports one is being billed at the full input rate on every
 * step of every turn.
 *
 * It goes through the real driver with the real system prompt and the real tool
 * schemas, because that is the thing in question. A hand-written curl would prove only
 * that Google can cache something, not that it caches what WE send.
 *
 * Usage (needs GEMINI_API_KEY in the environment):
 *   node --import tsx scripts/cacheProbe.mjs
 *   node --import tsx scripts/cacheProbe.mjs gemini-3.5-flash-lite gemini-3.7-flash
 *   node --import tsx scripts/cacheProbe.mjs --calls 8 gemini-3.5-flash-lite
 *
 * Reads nothing, writes nothing, changes no files. It only spends tokens — a default
 * run is 6 calls per model against a ~10K prefix, so cents, not dollars.
 */
import { basePrompt } from "../src/dynamo/prompt.ts";
import { toolSchemas } from "../src/tools/registry.ts";
import { toolTurn } from "../src/drivers/gemini/client.ts";

const argv = process.argv.slice(2);
let calls = 6;
const ci = argv.indexOf("--calls");
if (ci !== -1) {
  calls = Number(argv[ci + 1]);
  argv.splice(ci, 2);
}
// The suspect first, then a model already measured to cache, as the control. Without a
// control a run of zeroes cannot tell "this model does not cache" from "the probe is
// wrong", which is the whole failure mode this script exists to avoid.
const models = argv.length > 0 ? argv : ["gemini-3.5-flash-lite", "gemini-3.7-flash"];

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set — nothing to probe.");
  process.exit(1);
}

const system = basePrompt("powershell");
const tools = toolSchemas();

async function probe(model) {
  console.log(`\n=== ${model}`);
  console.log("  call   prompt      hit     miss   hit%   out");
  // Append-only, exactly like a real session: every call repeats the whole prefix and
  // adds a little at the end. That is the shape prefix caching is supposed to reward.
  const messages = [];
  let hitTotal = 0;
  let promptTotal = 0;
  for (let i = 1; i <= calls; i++) {
    messages.push({ role: "user", content: `Step ${i}: reply with the single word ok.` });
    let turn;
    try {
      turn = await toolTurn({ system, messages, tools, model: { model } });
    } catch (error) {
      console.log(`  ${String(i).padStart(4)}   failed: ${error?.message ?? error}`);
      return;
    }
    messages.push({ role: "assistant", content: turn.content || "ok" });
    const u = turn.usage;
    if (!u) {
      console.log(`  ${String(i).padStart(4)}   (this provider reported no usage at all)`);
      continue;
    }
    hitTotal += u.cacheHitTokens;
    promptTotal += u.promptTokens;
    const pct = u.promptTokens ? (100 * u.cacheHitTokens) / u.promptTokens : 0;
    console.log(
      `  ${String(i).padStart(4)} ${String(u.promptTokens).padStart(8)} ${String(u.cacheHitTokens).padStart(8)}` +
        ` ${String(u.cacheMissTokens).padStart(8)} ${pct.toFixed(1).padStart(6)} ${String(u.completionTokens).padStart(5)}`,
    );
  }
  const overall = promptTotal ? (100 * hitTotal) / promptTotal : 0;
  console.log(`  ---- ${String(promptTotal).padStart(8)} ${String(hitTotal).padStart(8)}` +
    `          ${overall.toFixed(1).padStart(6)}   overall`);
  // The first call can never hit — nothing is cached yet. A model that caches shows its
  // first hit by call 2 or 3 and then keeps it; one that never warms up stays at zero.
  if (hitTotal === 0) console.log(`  VERDICT: no cache hit in ${calls} calls sharing a ~${Math.round(promptTotal / calls / 1000)}K prefix.`);
}

console.log(`system prompt + ${tools.length} tool schemas, ${calls} calls per model, appended conversation`);
for (const m of models) await probe(m);
