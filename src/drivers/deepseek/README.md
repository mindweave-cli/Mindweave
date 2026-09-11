# DeepSeek driver (reference)

The reference driver — copy this shape when building a new one.

**Models:** `deepseek-v4-flash` (V4.1 Flash — fast, cheap, reads images, default) and
`deepseek-v4-pro` (stronger, offered until DeepSeek folds it into V4.1 Flash). Both are
OpenAI-compatible and support a thinking / non-thinking toggle with a `reasoning_effort`
budget.

**API shape:** OpenAI-compatible `chat/completions` with native function-calling
(`tools[]` → `tool_calls`) and SSE streaming. Prompt caching is automatic — it only
needs a byte-stable prefix, which `ModelRequest` already guarantees.

**Key:** `DEEPSEEK_API_KEY` (env var, or in your config `.env`).

## Status

The live DeepSeek implementation currently sits in `dynamo/`:

- `dynamo/deepseek.ts` — the HTTP client, streaming, request rendering.
- `dynamo/model.ts` — the DeepSeek model list + `/think` levels.
- `dynamo/pricing.ts` — DeepSeek per-token prices.
- `dynamo/contextWindow.ts` — DeepSeek context window + compaction thresholds.

**First migration task:** move these into this folder behind the `Driver` interface
(see `../README.md`). It's a behavior-preserving refactor — a good first
contribution.
