# Real LLM Tool-Call Verification

## 1. Scope

This was a discovery/manual smoke-test pass, not an implementation. Goal: verify whether
real models — reached through eureka-flows-api's Generate API — can produce structured
tool calls usable by `ToolExecutor`, or whether every real gateway is correctly staying
text-only. No new gateway was built as part of this pass; see §7 for what stays as-is.

## 2. Model catalog result

Queried `GET /runs/0/models` against the real dev backend (`flw-d1`) on 2026-07-22.
Catalogs are backend-driven and can change; treat this as a snapshot, not a guarantee.

**Default model:**

- `gpt-5-mini`

**Available Gemini models:**

- `gemini-3.1-pro-preview`
- `gemini-3-flash-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`

**Available OpenAI models:**

- `gpt-5.2`
- `gpt-5.1`
- `gpt-5`
- `gpt-5-mini`
- `gpt-4.1`
- `gpt-4.1-mini`
- `gpt-4o`
- `gpt-4o-mini`

**Not listed** (do not assume these exist until re-checked against the live catalog):

- Claude
- OpenRouter
- DeepSeek
- GLM
- Qwen
- `gpt-5.4-mini`

## 3. BaseAgent finding

Before this pass, `BaseAgent.send()` always fetched and sent `ToolExecutor`'s tool
definitions on every turn, regardless of what the gateway could do with them. Any gateway
declaring `capabilities.toolCalls = false` (Gemini, the Generate API sync gateway) throws
on receiving non-empty tools — so `LocatorAgent` failed immediately, on the very first
turn, against every real-HTTP gateway, independent of whether the underlying model could
actually do function-calling.

Commit `aca032f` fixed this: `BaseAgent` now sends `tools: []` when
`gateway.capabilities?.toolCalls === false`, sends the listed tools when it's `true`, and
preserves the previous (tools-sent) behavior when `capabilities` is undefined, for
backward compatibility with gateways that haven't declared it yet
(`createCommandLlmGateway`).

## 4. Manual smoke-test scenario

**Prompt:**

```
Move the text input node 100px to the right.
```

**Expected structured tool call, if the backend supported it:**

```
move_node({ nodeId: "text-1", by: { dx: 100, dy: 0 } })
```

This mirrors the `LocatorAgent`/`ToolExecutor`/canvas-tools scenario already covered by
existing tests (see `llm-gateway.md` §3) — the point of this pass was to check whether a
_real_ model, through the _real_ Generate API, could produce the same structured call a
scripted fake gateway already proves works end-to-end.

## 5. Tested models and shapes

**Models:**

- `gemini-2.5-flash`
- `gpt-5-mini`
- `gpt-4o-mini`

**Request shapes**, each posted to `POST /runs/0/generate` with no `transport` param (the
non-WebSocket path confirmed synchronous in the earlier Phase 0 pass):

- **no-tools control** — the same prompt, no `tools` field at all (baseline for comparison)
- **generic `ToolDef`** — our own `libs/agent` tool-definition shape (`name`/`description`/
  `parameters`), untranslated
- **Gemini `functionDeclarations`** — Gemini's native function-calling request shape,
  tried against `gemini-2.5-flash` only
- **OpenAI `tools`/`function`** — OpenAI's native tool-calling request shape, tried against
  `gpt-5-mini` and `gpt-4o-mini`

3 models × 3 shapes each (Gemini gets its native shape, the GPT models get theirs; the
control and generic-`ToolDef` shapes ran against all three) = 9 real-backend calls total.

## 6. Results

- All 9 calls returned **HTTP 200**.
- All 9 returned **plain text** in both `output.content` and `text` — no structural
  difference between the no-tools control and the tool-carrying variants.
- **No** Gemini `candidate.content.parts[].functionCall` observed, in any variant.
- **No** OpenAI `tool_calls` observed, in any variant.
- The `tools` field appears to be **ignored**, not rejected — no 4xx/5xx, no validation
  error, no change in response shape versus the no-tools control.

## 7. Conclusion

- `/runs/0/generate` currently behaves as a **text-generation-only** endpoint. Attaching a
  tool/function schema in any of the three shapes tried has no observed effect.
- Real structured tool calling is **not supported** through this path today.
- Current real gateways (`createGeminiLlmGateway`, `createGenerateApiSyncLlmGateway`, the
  WebSocket/SLS `createGenerateApiLlmGateway`) should **keep `capabilities.toolCalls =
false`** — that self-declaration is now verified correct, not just cautious.
- `ToolExecutor` and the canvas tools (`list_nodes`, `move_node`) remain ready and fully
  tested against the fake gateway; nothing there needs to change.
- Backend structured tool-call support is a **backend follow-up**, not a frontend gateway
  fix — likely a conversation with Claire/the eureka-flows-api team about whether/how
  `/runs/0/generate` could accept and honor a tool schema.
- **Do not mark any real gateway as tool-capable until the backend actually returns
  structured tool calls.** Today, only the scripted `createFakeGateway` (test double) and
  `createCommandLlmGateway` (offline command parser, not a real model) can drive the
  tool-call path — neither is a real LLM proving this end-to-end.

## 8. Security note

While gathering this data, a pre-existing logging issue was found and fixed separately: the
WebSocket worker logged the full authenticated connection URL and raw token to the
browser console. That is **not** reproduced here — no raw API key, WebSocket URL, or
`x-api-key` value appears in this document or was used in the request bodies above (the
Generate API smoke calls use `x-api-key` as a header, not a logged value). The fix itself
is a separate commit (`fix(socket): redact websocket auth logs`) that redacts `x-api-key`
out of the worker's log messages while leaving the real connection/reconnect behavior
unchanged.
