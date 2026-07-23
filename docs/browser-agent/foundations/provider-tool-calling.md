# Provider-Native Tool-Calling Verification

## 1. Scope and why

Steve clarified that **eureka-flows-api is not designed for tool calling** — the Generate
endpoint is text-only (verified in `real-llm-tool-verification.md`: 9 real calls, all plain
text, `tools` field ignored). So structured tool-call verification runs **directly against
provider APIs**, behind the existing shared `LlmGateway` contract — not through eureka.

The eureka Generate gateways stay exactly as they are: `createGenerateApiSyncLlmGateway`
and `createGenerateApiLlmGateway` keep `capabilities.toolCalls = false`, and nothing here
changes them.

## 2. Providers

Each provider is a **separate** tool-capable gateway behind the shared contract; the
eureka Generate gateways and the existing text-only `createGeminiLlmGateway` are untouched.

- **OpenAI** — `createOpenAiLlmGateway` (`libs/agent/src/llm/`). First slice; most stable
  tool-calling wire format, `tool_calls[].function.arguments` is already a JSON string
  (maps straight to `Chunk.argsDelta`), and it doubles as **OpenRouter** (OpenAI-wire-
  compatible — same gateway, `baseUrl` override). See §3.
- **Gemini** — `createGeminiToolLlmGateway` (`libs/agent/src/llm/`), **separate from** the
  text-only `createGeminiLlmGateway` (which stays as-is). See §3a.

Both declare `capabilities.toolCalls = true` — honestly, since both providers genuinely
support it. Anthropic is a follow-up (§8).

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

## 3a. Mapping (ToolDef ⇄ Gemini)

**Request** (`ChatRequest` → Gemini `generateContent`):

- `ToolDef` → `tools: [{ functionDeclarations: [{ name, description, parameters }] }]`,
  omitted when no tools. **Schema casing:** Gemini's `parameters` expects OpenAPI-style
  **uppercase** `Type` enums (`OBJECT`/`STRING`/`NUMBER`/`INTEGER`/`BOOLEAN`/`ARRAY`), while
  our `ToolDef.parameters` is lowercase JSON Schema — so a recursive `toGeminiSchema`
  uppercases every `type` (through nested `properties`/`items`), leaving
  `required`/`description`/`enum` as-is.
- system messages → `systemInstruction`; user/assistant-text → `contents` (`assistant` →
  `model` role), same as the text-only gateway.

**Response** (Gemini → `Chunk`):

- `candidates[0].content.parts[].functionCall = { name, args(object) }` → `{ toolCall: {
id: <generated>, name, argsDelta: JSON.stringify(args) } }`. Gemini's `args` is a parsed
  **object** (unlike OpenAI's string), so we stringify it; Gemini gives **no call id**, so we
  generate a turn-local one (`gemini-call-N`). `text` parts → a `text` chunk.

**Scope-B boundary:** Gemini identifies tool _results_ by function **name** (`functionResponse`
parts), but our tool messages carry only a `toolCallId`, so mapping results back needs
name-correlation across the transcript — genuine Scope-B work. Rather than guess, the gateway
**throws** a clear error if handed a tool message or an assistant turn carrying tool calls.
(OpenAI's format needs no correlation, so its gateway maps those trivially.)

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

- **Offline mapping/parsing — proven** for both providers. `OpenAiLlmGateway.spec.ts` (13
  tests) and `GeminiToolLlmGateway.spec.ts` (13 tests), via `ScriptedHttpRequest`, no network:
  request mapping (incl. Gemini's uppercase-schema conversion), `tool_calls`/`functionCall`
  parsing, text parsing, key redaction, abort passthrough, the Scope-B throw boundary, and the
  full **canned-response → `Chunk.toolCall` → `ToolExecutor` → node moves `(100,200)`→`(200,200)`**
  chain. This proves _our code_, not the models' behavior.
- **Real provider calls — pending keys.** `realProviderToolCall.spec.ts` has one
  `describe.runIf(...)` block per provider (`OPENAI_API_KEY`, `GEMINI_API_KEY`), sharing one
  Scope-A verification helper; both currently **skipped** (no keys). Each runs Scope A against
  the live API via `createFetchHttpRequest()`.
- **Not yet claimed working.** A provider's tool calling is **not** verified until its
  env-gated block runs green against a real key. Until then: offline code is proven, real
  behavior is not.

## 6. Env vars (names only — never committed, never `VITE_`, never logged)

Read from `process.env.*` in the Node test environment only:

- `OPENAI_API_KEY` — gates the OpenAI real test. `OPENAI_TEST_MODEL` — optional override
  (default `gpt-4o-mini`).
- `GEMINI_API_KEY` — gates the Gemini real test. `GEMINI_TEST_MODEL` — optional override
  (default `gemini-2.5-flash`).
- `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` — for the follow-up providers (§8).

These are **not** browser vars. They must **not** go in `apps/web/.env.example` (that file is
Vite/browser config and would bundle secrets into client code). They are test/CI-only,
supplied at run time (`OPENAI_API_KEY=… npx nx test agent`), and appear here by **name only**.

## 7. Security

- Keys are Node/test-only — never read into a browser bundle, never a `VITE_` var.
- Never logged: keys go in the auth header (OpenAI `Authorization: Bearer`, Gemini
  `x-goog-api-key`), are redacted from any error body before throwing, and never traced
  (trace-leak asserted in each gateway's tests).
- **Browser/production use of a real provider gateway is out of scope and proxy-gated** —
  OpenAI/Anthropic block browser calls, and every provider exposes the key in-browser
  regardless of CORS. Verification runs Node-only and sidesteps this entirely; a production
  browser path would go through the backend proxy noted in `llm-gateway.md` §7.

## 8. Follow-ups

- Run the env-gated OpenAI and Gemini tests green against real keys (the actual claim).
- Add Anthropic (`input_schema`, `tool_use` blocks) and OpenRouter model configs.
- Scope B: multi-turn tool-result round-trip mapping — for Gemini specifically, the
  name-correlated `functionResponse` mapping the gateway currently throws on — for a complete
  real-LLM LocatorAgent run.
