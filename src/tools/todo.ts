/**
 * todo.ts — the session task list.
 *
 * On a multi-step job a model drifts: it forgets a step, repeats one, or declares
 * done while something's unfinished. A model-maintained checklist fixes that. It is
 * NOT shown to the user (see the quiet flag on the result): the tool rows that carry
 * meaning are the ones showing work happening, and a "list rewritten" row between
 * them, repeated every time a single item changed state, was noise around the signal.
 * The list still does its whole job unseen, because its reader is the model. The model
 * rewrites the WHOLE list
 * each call (simplest correct model: no partial-update bugs); we store it on the
 * ToolContext and the engine injects it into the system prompt every turn, so the
 * plan is always in front of the model. Because it lives outside the transcript,
 * the plan also survives compaction.
 *
 * Thin-prompt boundary: this description teaches only the mechanical CONTRACT
 * (the three states, one in_progress at a time, the two text forms, complete-
 * immediately). Deciding WHEN a task is worth a list, and how to break it down,
 * is the model's judgment — we don't script that here (a long when-to-use essay is
 * exactly the kind of model-work we keep out of the prompt).
 */
import type { Tool, ToolContext, ToolResult, TodoItem, TodoStatus } from "./types.js";

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

export const todoWrite: Tool = {
  name: "todo_write",
  readOnly: false,
  description:
    "Create and update your task list for the current job. Pass the COMPLETE list " +
    "every time (it replaces the previous one). Use it for any task of roughly 3+ " +
    "steps to track progress and show the user where things stand; skip it for " +
    "trivial one-step work. The current list is put back in front of you every turn, " +
    "so you never need to call this just to see it, and you never need to restate it " +
    "in your reply. Keep exactly one task 'in_progress' at a time, mark a " +
    "task 'completed' the moment it's truly done (not before — not if tests fail or " +
    "work is partial), and drop tasks that no longer apply. When all tasks are " +
    "completed the list clears itself.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        description: "The full, updated task list.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["content", "activeForm", "status"],
          properties: {
            content: {
              type: "string",
              description: "Imperative form of the task, e.g. 'Run the tests'.",
            },
            activeForm: {
              type: "string",
              description: "Present-continuous form shown while active, e.g. 'Running the tests'.",
            },
            status: {
              type: "string",
              enum: STATUSES,
              description: "pending | in_progress | completed.",
            },
          },
        },
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const parsed = parseTodos(args.todos);
    if (typeof parsed === "string") return fail(parsed);

    // All done → clear the list (a finished list disappears).
    const allDone = parsed.length > 0 && parsed.every((t) => t.status === "completed");
    ctx.todos = allDone ? [] : parsed;

    const inProgress = parsed.filter((t) => t.status === "in_progress").length;
    const notes: string[] = [];
    if (inProgress > 1) {
      notes.push(`Note: ${inProgress} tasks are in_progress — keep it to one at a time.`);
    }

    const body = allDone
      ? "All tasks completed — list cleared."
      : render(parsed);
    const output = [body, ...notes, "", "Keep the list updated as you work."].join("\n");

    // QUIET: the list never renders a row. It is the model's own scratch memory for
    // staying on track across a long job, and the engine puts it back in front of the
    // model every turn — so it works exactly as well unseen. On screen it was noise:
    // a row that says a checklist was rewritten, printed again every time one item
    // moved, in between the rows that show actual work.
    //
    // The model still gets the full output, including the one-at-a-time nudge.
    return { output, summary: summarize(parsed, allDone), quiet: true };
  },
};

/** Validate and normalize the model's `todos` argument. Returns items or an error string. */
function parseTodos(raw: unknown): TodoItem[] | string {
  if (!Array.isArray(raw)) return "`todos` must be an array of task objects.";
  const items: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown> | null;
    if (!t || typeof t !== "object") return `todos[${i}] must be an object.`;
    const content = typeof t.content === "string" ? t.content.trim() : "";
    const activeForm = typeof t.activeForm === "string" ? t.activeForm.trim() : "";
    const status = t.status as TodoStatus;
    if (!content) return `todos[${i}].content is required.`;
    if (!activeForm) return `todos[${i}].activeForm is required.`;
    if (!STATUSES.includes(status)) return `todos[${i}].status must be one of: ${STATUSES.join(", ")}.`;
    items.push({ content, activeForm, status });
  }
  return items;
}

/** Render a checklist the model reads back (and the basis for the prompt block). */
export function render(todos: TodoItem[]): string {
  return todos.map((t) => `${box(t.status)} ${label(t)}`).join("\n");
}

function box(status: TodoStatus): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
}

/** In-progress tasks read in their active form ("Running tests"); others imperative. */
function label(t: TodoItem): string {
  return t.status === "in_progress" ? t.activeForm : t.content;
}

function summarize(todos: TodoItem[], allDone: boolean): string {
  if (allDone) return "all tasks completed";
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  const head = active ? `→ ${active.activeForm}` : "task list updated";
  return `${head} (${done}/${todos.length} done)`;
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}

/**
 * The block injected into the system prompt each turn. Empty string when there's
 * no list, so it costs nothing until the model starts one.
 */
export function todoListText(ctx: ToolContext): string {
  if (!ctx.todos || ctx.todos.length === 0) return "";
  return render(ctx.todos);
}
