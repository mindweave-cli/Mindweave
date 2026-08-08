/**
 * registry.ts — the one list of tools the engine can use.
 *
 * Adding a capability to Mindweave is: write the tool file, import it here, add it
 * to TOOLS. The engine reads from this registry and nowhere else, so it never
 * needs to change when tools come and go.
 */
import type { Tool, ToolSchema } from "./types.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { editFile } from "./editFile.js";
import { multiEdit } from "./multiEdit.js";
import { runCommand } from "./runCommand.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listDir } from "./listDir.js";
import { outlineTool, definitionTool, referencesTool, relevantTool } from "./codeIntel.js";
import { readSymbolTool } from "./readSymbol.js";
import { replaceSymbolBody } from "./replaceSymbol.js";
import { diagnosticsTool } from "./diagnostics.js";
import { webFetch } from "./webFetch.js";
import { webSearch } from "./webSearch.js";
import { screenshot } from "./screenshot.js";
import { todoWrite } from "./todo.js";
import { useSkill } from "./useSkill.js";
import { rememberRule, forbidPath, forbidCommand, forbidMcpTool, createSkill } from "./governorTools.js";
import { saveMemoryTool } from "./saveMemory.js";
import { askUserTool } from "./askUser.js";
import { addDirectory, linkWorkspace } from "./workspace.js";
import { shellOutput, killShell, listShells } from "./shellTools.js";
import { spawnSubagent } from "./subagent.js";
import { listSessionsTool, readSessionTool } from "./sessionTools.js";
import { findMcpTools } from "./mcpSearch.js";
import { listMcpResources, readMcpResource } from "./mcpResources.js";
import { addMcpServer } from "./mcpAdd.js";

export const TOOLS: Tool[] = [
  // Discovery (read-only)
  listDir,
  globTool,
  grepTool,
  readFile,
  webSearch,
  webFetch,
  // Code intelligence (read-only, chassis-backed)
  outlineTool,
  definitionTool,
  referencesTool,
  relevantTool,
  readSymbolTool,
  diagnosticsTool,
  // Background shells (read-only: inspect long-running commands)
  shellOutput,
  listShells,
  // External integrations (read-only: finds MCP tools, and reads the DATA servers expose
  // as opposed to the actions they perform)
  findMcpTools,
  listMcpResources,
  readMcpResource,
  // Own history (read-only: what this agent did in this project before)
  listSessionsTool,
  readSessionTool,
  // Skills (read-only: loads a procedure into context on demand)
  useSkill,
  // Clarification (read-only: asks the user a focused question, changes nothing)
  askUserTool,
  // Sight (read-only: photographs one approved window, changes nothing)
  screenshot,
  // Action (mutating)
  writeFile,
  editFile,
  multiEdit,
  replaceSymbolBody,
  spawnSubagent,
  runCommand,
  todoWrite,
  addDirectory,
  linkWorkspace,
  killShell,
  // Cross-session memory (mutating: persists what the model is asked to remember)
  saveMemoryTool,
  // Governor (mutating: persist a rule / forbidden path / skill for the project)
  rememberRule,
  forbidPath,
  forbidCommand,
  forbidMcpTool,
  addMcpServer,
  createSkill,
];

/** Look up a tool by the name the model called. */
export function findTool(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * The OpenAI-style `tools[]` array we send to the provider so the model knows
 * what it can call. Built straight from the registry — one source of truth.
 *
 * In `planMode` (the CLI's Architect mode) only read-only tools are advertised,
 * so the model plans and researches without ever being offered edit/write/run.
 * `readOnlyOnly` does the same filtering without the plan framing — used to make a
 * research sub-agent read-only. Execution is guarded independently in the engine,
 * so a stray mutating call is still refused — this just keeps the model from
 * reaching for one.
 */
export function toolSchemas(opts: { planMode?: boolean; readOnlyOnly?: boolean } = {}): ToolSchema[] {
  const readOnly = opts.planMode || opts.readOnlyOnly;
  const tools = readOnly ? TOOLS.filter((tool) => tool.readOnly) : TOOLS;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
