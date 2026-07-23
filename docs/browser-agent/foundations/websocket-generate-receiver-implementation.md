# WebSocket Generate Receiver — Implementation Notes

## 1. Context

`docs/browser-agent/foundations/websocket-generate-verification.md` recorded a backend-blocked
outcome: no frame at all was ever observed for `transport=1`, and it explicitly recommended not
implementing a `GenerateReceiver` until the backend contract was confirmed.

Per updated direction, backend/API has since clarified `connection=<connectionId>&transport=1` is
the intended async WebSocket path, and the HTTP 200/202 is only an ACK. A pasted Generate API spec
(2026-07-23) gave the actual contract. **That spec does not describe a chunked/streaming protocol**
— an earlier revision of this work assumed `json:manifest`/`json:chunk`/`json:complete` frames
based on older internal notes; that assumption did not match this spec and has been removed. The
spec describes a single `GenerateResponse` object delivered once over the socket.

## 2. What the spec actually says (vs. what was assumed earlier)

| Spec point           | Earlier assumption                             | Now                                                                                                            |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Result delivery      | 3-frame stream: manifest → chunk(s) → complete | **One frame** carrying the full `GenerateResponse`                                                             |
| Receiver type        | —                                              | `ProxyTransportReceiver<T>` from `lemon-model`                                                                 |
| Auth                 | —                                              | `VITE_WORKSPACE_API_KEY` (spec's illustrative raw-`fetch` example)                                             |
| Frame identification | Hardcoded `action` string match                | Structural match (`connectionId` + `output`) — the real action/type name was never confirmed by either version |

**`ProxyTransportReceiver` is not importable today.** `node_modules/lemon-model@1.1.1`'s
`dist/index.d.ts` exports only `./types` and `./cores` — no such symbol — and the package's own
README describes it as "common shared model definitions" (DTOs), not a transport/receiver library.
`grep` across the repo confirms zero `import ... from 'lemon-model'` statements anywhere in source
(only a comment in `useInitFlowSocket.ts` referencing its `progress:*`/`log:*` envelope
_convention_, unrelated to Generate). `package.json` declares `^1.2.3` but the installed copy is
`1.1.1` — the install is stale — and the newer version's exports were not checked here (network/disk
constraints during this work). **Until `ProxyTransportReceiver` is confirmed to exist and be
importable, `GenerateReceiver<T>` (defined locally in `createGenerateApiLlmGateway.ts`) stands in
for it** — the module doc there says so explicitly.

**`VITE_WORKSPACE_API_KEY` is not used.** It doesn't exist anywhere in this repo. The gateway
authenticates via `api.post` (`@flows/web-core`), whose axios interceptor sets `x-api-key` from the
logged-in user's dynamic `apiKey` (`useWebCoreStore`) and prepends `/_api_` for any real key —
producing the same `${API_URL}/_api_/runs/0/generate?connection=...&transport=1` request the spec
describes. `createGenerateApiSyncLlmGateway` — already confirmed working against the real backend
for this same endpoint family — authenticates the same way. Introducing a separate static key would
diverge from a proven-working pattern without a confirmed reason to.

## 3. What changed (this revision)

- **`libs/socket/src/hooks/useInitFlowSocket.ts`**: `parseWebSocketMessage` recognizes a Generate
  result **structurally** — any frame with a resolvable `connectionId` and an `output` field —
  rather than matching a guessed `action` string. Tries the frame's wrapped `data` field first
  (matching the `trace`/`message` convention already used by this parser), then the top level, so
  it works whether or not the result turns out to be wrapped. `output` isn't used by any other
  message type here (flow/node/port/progress/log/trace/product-progress all lack it), so this is a
  safe discriminator. A frame with no resolvable `connectionId` is dropped with a `console.warn`.
- **`apps/web/.../hooks/useGenerateReceiver.ts`**: resolves on the **first** matching frame for a
  `connectionId` — no chunk accumulation. Added:
    - **Timeout**: `wait()` races the pending promise against a timer (default 60s, configurable via
      `useGenerateReceiver(timeoutMs)`); on expiry it rejects with a clear "timed out" message and
      cleans up.
    - **`cancelAll(reason)`**: rejects every in-flight wait at once. Wired from `FlowEditorPage` to
      fire when the socket disconnects mid-request, so a lost connection surfaces as a visible error
      instead of hanging forever — no automatic retry (per spec, the user must resend).
- **`FlowEditorPage.tsx`**: watches `isSocketConnected` for a `true → false` transition (a `useRef`
  guards against firing on initial mount, when it starts `false`) and calls `cancelGenerateWaits`.
- **`FlowAgentPanel.tsx`** / gateway selection: unchanged from the prior revision — still gated on
  `VITE_AGENT_GATEWAY=generate-ws`, still additive to the existing `generate-sync` and default
  command-gateway paths.
- **`createGenerateApiLlmGateway.ts`**: added a temporary, dev-gated diagnostic at the top of
  `chat()` — `if (import.meta.env.DEV) console.warn('[GenerateApiLlmGateway] chat() reached',
{isConnected, connectionId, hasGenerateReceiver})`. `DEV`-gated so it's dead-code-eliminated from
  production builds; `console.warn` rather than `.debug` since Chrome's "Verbose" console filter
  hides `.debug` by default. To be removed once the WS-delivery investigation (§4.4) is resolved.

Nothing about `createGenerateApiSyncLlmGateway` changed.

## 4. Remaining open items

1. **The real wire shape for the result frame is still unconfirmed** — the spec describes the
   `GenerateResponse` object's fields but not the outer WS envelope/action name that carries it.
   The structural match (§3) is a best effort, not a verified fact.
   `ProxyTransportReceiver`'s exact shape (assumed here to be `wait(connectionId, fire): Promise<T>`,
   matching the spec's usage example) is likewise unconfirmed until it's an actual importable type.
2. **Whether `lemon-model@1.2.3`+ actually exports `ProxyTransportReceiver`** — not checked (see
   §2). If it does, `useGenerateReceiver`'s `GenerateReceiver<T>` local interface should be
   type-aligned to it (or replaced) once the package is up to date and the export is confirmed.
3. **UI-level "disable Generate action while disconnected"** (spec's guard is described as
   disabling the action, not throwing after the fact) — not implemented. Today, `chat()` throws
   synchronously if `isConnected`/`connectionId`/`generateReceiver` are falsy, which blocks the POST
   and surfaces an error the same as before, but the send button itself isn't disabled. Left out of
   this revision as a separate, larger change (touches the shared `AgentPanel` component used by
   every gateway, not just `generate-ws`).
4. **Resolved**: `POST /runs/0/generate` was initially not observed despite the subtitle confirming
   `generate-ws` was selected. Root cause was an in-memory session stuck in `phase: 'thinking'` from
   an earlier attempt made before the timeout fix existed — `BaseAgent.send()` silently no-ops on a
   session already `thinking`, before ever reaching `gateway.chat()`. A page reload (which
   re-hydrates and sanitizes a persisted `thinking` phase back to `idle`) resolved it. Live
   verification after that confirmed `chat()` reached, `POST` fires with correct
   `connection`/`transport=1` params, and the HTTP ACK is correct — but no final `GenerateResponse`
   frame arrives over the WS connection. See
   [`generate-ws-backend-escalation.md`](generate-ws-backend-escalation.md) for the full report.

## 5. Manual verification steps (run against the real dev backend)

Not re-run live as part of this revision — run before merging:

1. Start the dev server with `VITE_AGENT_GATEWAY=generate-ws` set.
2. Open a flow, open DevTools → Console (for the `chat() reached` diagnostic) and → Network → WS →
   the flow socket → Messages tab (raw frames).
3. Send a chat message in FlowAgentPanel.
4. Check the console for `[GenerateApiLlmGateway] chat() reached { isConnected, connectionId,
hasGenerateReceiver }`. If it's missing, `chat()` was never invoked — check whether `send()`
   actually fired (e.g. `window.__flowAgentTrace()` in dev shows `agent.run.start`/`agent.run.error`
   entries). If present with a falsy field, that's why no POST fires — matches the spec's guard.
5. If `chat()` was reached and all three fields were truthy, check Network for `POST
/runs/0/generate` and confirm `connection=`/`transport=1` in the query string, and that
   `connection=` matches `data.connectionId` from the WS `info` frame.
6. Watch WS Messages for a frame with `output`/`connectionId` fields arriving after the ACK. If one
   arrives, confirm the chat reply renders; if the shape differs from what the parser expects
   (§3), note the actual field names for a follow-up fix.
7. If no frame ever arrives, or `wait()` times out (default 60s) with the console diagnostic
   confirming `chat()` was reached and the POST fired correctly, this reproduces the original
   verification's backend-contract gap — re-open `websocket-generate-verification.md` §6 rather
   than re-guessing the frontend implementation further.
