/**
 * deferredNative.ts — Mindweave's own tools that are held back behind search.
 *
 * The same trade `src/mcp/deferred.ts` makes for MCP catalogs, applied to native tools:
 * a model choosing among 25 tools chooses better than one choosing among 38, and the
 * schemas of tools a session never touches are paid for on every uncached request. What
 * is deferred stays fully reachable through `find_tools`, and activation is sticky for
 * the session, so the cost is one round trip per capability rather than per call.
 *
 * The tools here are imported DIRECTLY rather than filtered out of the registry, and
 * that is load-bearing rather than stylistic: `registry.ts` imports `find_tools`, so a
 * pool that read from the registry would close a cycle, and whichever module a test
 * happened to import first would hit the other's uninitialised bindings. Importing the
 * leaves keeps the graph acyclic. The registry still owns which tools EXIST; this owns
 * only which of them are held back.
 *
 * What belongs here: genuinely occasional capabilities. A tool in the core loop must
 * never be deferred — the search round trip would cost more than its schema ever did.
 */
import type { Tool } from "./types.js";
import { screenshot } from "./screenshot.js";
import { saveMemoryTool } from "./saveMemory.js";
import { governor, createSkill } from "./governorTools.js";
import { sessionsTool } from "./sessionTools.js";
import { mcpResourceTool } from "./mcpResources.js";
import { workspaceTool } from "./workspace.js";
import { todoWrite } from "./todo.js";
import { askUserTool } from "./askUser.js";
import { outlineTool, definitionTool, referencesTool } from "./codeIntel.js";
import { web } from "./web.js";
import { replaceSymbolBody } from "./replaceSymbol.js";
import { spawnSubagent } from "./subagent.js";
import { addMcpServer } from "./mcpAdd.js";

/** The pool, in the order it is named to the model. */
export const DEFERRED_TOOLS: Tool[] = [
  todoWrite,
  askUserTool,
  outlineTool,
  definitionTool,
  referencesTool,
  spawnSubagent,
  web,
  replaceSymbolBody,
  governor,
  createSkill,
  saveMemoryTool,
  sessionsTool,
  workspaceTool,
  mcpResourceTool,
  addMcpServer,
  screenshot,
];

/**
 * The one line about the pool that goes in the system prompt.
 *
 * It exists so the model knows these capabilities are REACHABLE rather than absent.
 * Without it a deferred tool is indistinguishable from a missing feature, and the model
 * routes around something it actually has — which costs far more than the schemas ever
 * did. Names only, no descriptions: enough to prompt a search, cheap enough that the
 * trade is obviously worth it.
 */
export function deferredToolsIndex(): string {
  if (DEFERRED_TOOLS.length === 0) return "";
  return (
    `Some of your own tools are not listed above. Their names: ` +
    `${DEFERRED_TOOLS.map((t) => t.name).join(", ")}. ` +
    `Only the name is known until you fetch one — find_tools returns the full schema, and ` +
    `from that moment the tool is callable exactly like the ones listed above. ` +
    `When a task needs one, search for it rather than concluding you cannot do it.`
  );
}

/**
 * Render one deferred tool the way the advertised list renders it: name, description and
 * the full JSON parameter schema.
 *
 * This is what makes deferral cache-safe. The schema is delivered in the SEARCH RESULT,
 * which is an ordinary message appended to the conversation, rather than by adding the
 * tool to the advertised `tools` array. An appended message leaves every earlier byte
 * untouched, so the provider's cached prefix survives and the schema itself is cached
 * from the next call onward. Mutating the array instead re-writes the prefix — tools,
 * system and messages — at full price, which cost several times what the deferral saved.
 *
 * The model can call the tool from this alone: dispatch resolves against the registry,
 * not against what was advertised, so a name and a schema is everything it needs.
 */
export function renderToolSchema(tool: Tool): string {
  return `<function>${JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })}</function>`;
}

/**
 * Rank the pool against a search query (pure).
 *
 * Deliberately the same blunt keyword approach as the MCP ranker: the model queries
 * with a capability word ("memory", "skill", "screenshot") or a tool name, not a
 * sentence, so precision matters less than never returning nothing for a fair query.
 */
export function matchDeferred(query: string): Tool[] {
  const terms = query.toLowerCase().trim().split(/[^a-z0-9]+/).filter(Boolean);
  if (terms.length === 0) return [];
  return DEFERRED_TOOLS.map((tool) => {
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 20; // the model named the tool outright
      else if (name.includes(term)) score += 10;
      // A description hit is weak on its own: descriptions are long and mention a lot.
      if (description.includes(term)) score += 2;
    }
    return { tool, score };
  })
    .filter((s) => s.score > 0)
    // Ties break on name so identical searches return identical results.
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map((s) => s.tool);
}
