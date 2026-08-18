/**
 * measureToolTokens.mjs — what the advertised tool schemas cost per uncached request.
 *
 * The tool block is sent on every request that misses cache, so its size is paid
 * repeatedly rather than once. This prints the total and the per-tool breakdown so a
 * trimming decision is made against a measurement instead of an intuition.
 *
 * Uses the same chars/4 estimator the product budgets with (memory/compaction.ts), so
 * the number here is comparable to every other token figure Mindweave reports.
 *
 *   npm run build && node scripts/measureToolTokens.mjs
 */
import { toolSchemas, TOOLS } from "../dist/tools/registry.js";

const estimate = (text) => (text ? Math.ceil(text.length / 4) + 1 : 0);

const schemas = toolSchemas();
const total = estimate(JSON.stringify(schemas));

console.log(`advertised tools : ${schemas.length}   (registry total ${TOOLS.length})`);
console.log(`schema JSON chars: ${JSON.stringify(schemas).length}`);
console.log(`estimated tokens : ${total}`);

const per = schemas
  .map((s) => [s.function.name, estimate(JSON.stringify(s))])
  .sort((a, b) => b[1] - a[1]);

console.log("\nheaviest 12:");
for (const [name, tokens] of per.slice(0, 12)) console.log(`  ${String(tokens).padStart(5)}  ${name}`);
