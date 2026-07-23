# Provider-Native Tool-Calling Verification

## 1. Scope and why

Steve clarified that **eureka-flows-api is not designed for tool calling** — the Generate
endpoint is text-only (verified in `real-llm-tool-verification.md`: 9 real calls, all plain
text, `tools` field ignored). So structured tool-call verification runs **directly against
provider APIs**, behind the existing shared `LlmGateway` contract — not through eureka.

The eureka Generate gateways stay exactly as they are: `createGenerateApiSyncLlmGateway`
and `createGenerateApiLlmGateway` keep `capabilities.toolCalls = false`, and nothing here
changes them.

## 2. v1 — one provider (OpenAI)

First slice is **OpenAI only** (`createOpenAiLlmGateway`, `libs/agent/src/llm/`). Chosen
first because its tool-calling wire format is the most stable, its `tool_calls[].function.
arguments` is already a JSON string (maps straight to `Chunk.argsDelta`), and it doubles as
**OpenRouter** (OpenAI-wire-compatible — same gateway, just a `baseUrl` override). It
declares `capabilities.toolCalls = true` — honestly, since OpenAI genuinely supports it.

Gemini, Anthropic, and OpenRouter-specific models are follow-ups (§6).

## 3. Mapping (ToolDef ⇄ OpenAI)

**Request** (`ChatRequest` → OpenAI Chat Completions):

- `ToolDef { name, description, parameters }` → `tools: [{ type: 'function', function: {
name, description, parameters } }]` (our `parameters` JSON Schema, as-is), with
  `tool_choice: 'auto'`. Omitted entirely when the request carries no tools.
- assistant tool-call turn → `{ role: 'assistant', content, tool_calls: [{ id, type:
'function', function: { name, arguments } }] }` (our `args` string → `arguments`).
- tool result → `{ role: 'tool', tool_call_id, content }`.

**Response** (OpenAI → `Chunk`):

- `choices[0].message.tool_calls[] = { id, function: { name, arguments(string) } }` →
  `{ toolCall: { id, name, argsDelta: arguments } }` — one chunk per call, whole args in one
  `argsDelta` (non-streaming). `BaseAgent.collect()` accumulates + `JSON.parse`s it exactly
  as it does the fake gateway's output.
- `message.content` (string, non-empty) → a `text` chunk. A tool-call turn's `content: null`
  is **not** an error here (unlike the text-only gateways).
- `usage.prompt_tokens`/`completion_tokens` → `inputTokens`/`outputTokens` on `done`.

## 4. Verification scenario

Prompt: **"Move the text input node 100px to the right."** — node `text-1` (`text-input`) at
`(100, 200)`. Expected structured call: `move_node({ nodeId: "text-1", by: { dx: 100, dy: 0 }
})`. After `ToolExecutor.dispatch`, the node is at `(200, 200)`.

Scope A (v1): gateway + `ToolExecutor`, single turn — the smallest thing that meets Steve's
bar ("one real provider returns structured tool calls and ToolExecutor executes it"). The
multi-turn LocatorAgent continuation (mapping tool _results_ back into each provider's
format for the model's confirmation turn) is a separate follow-up (§6), not required to
prove the bar.

## 5. Status

- **Offline mapping/parsing — proven.** `libs/agent/src/__tests__/llm/OpenAiLlmGateway.spec.ts`
  (13 tests, via `ScriptedHttpRequest`, no network): request mapping, tool-schema mapping,
  `tool_calls` parsing, text parsing, key redaction, abort passthrough, and the full
  **canned-response → `Chunk.toolCall` → `ToolExecutor` → node moves `(100,200)`→`(200,200)`**
  chain. This proves _our code_, not the model's behavior.
- **Real provider call — pending a key.** `libs/agent/src/__tests__/llm/realProviderToolCall.spec.ts`
  is `describe.runIf(!!process.env.OPENAI_API_KEY)` — currently **skipped** (no key). It runs
  Scope A against the live OpenAI API via `createFetchHttpRequest()`.
- **Not yet claimed working.** Provider tool calling is **not** verified until that env-gated
  test runs green against a real key. Until then: offline code is proven, real behavior is not.

## 6. Env vars (names only — never committed, never `VITE_`, never logged)

Read from `process.env.*` in the Node test environment only:

- `OPENAI_API_KEY` — used by the v1 real test now.
- `OPENAI_TEST_MODEL` — optional override (default `gpt-4o-mini`).
- `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` — for the follow-up providers.

These are **not** browser vars. They must **not** go in `apps/web/.env.example` (that file is
Vite/browser config and would bundle secrets into client code). They are test/CI-only,
supplied at run time (`OPENAI_API_KEY=… npx nx test agent`), and appear here by **name only**.

## 7. Security

- Keys are Node/test-only — never read into a browser bundle, never a `VITE_` var.
- Never logged: the gateway sends the key as an `Authorization: Bearer` header, redacts it
  from any error body before throwing, and never traces it (trace-leak asserted in tests).
- **Browser/production use of a real provider gateway is out of scope and proxy-gated** —
  OpenAI/Anthropic block browser calls, and every provider exposes the key in-browser
  regardless of CORS. Verification runs Node-only and sidesteps this entirely; a production
  browser path would go through the backend proxy noted in `llm-gateway.md` §7.

## 8. Follow-ups

- Run the env-gated OpenAI test green against a real key (the actual claim).
- Add Gemini (tool-capable variant — do **not** mutate the text-only `createGeminiLlmGateway`),
  Anthropic (`input_schema`, `tool_use` blocks), and OpenRouter model configs.
- Scope B: multi-turn tool-result round-trip mapping, for a complete real-LLM LocatorAgent run.
