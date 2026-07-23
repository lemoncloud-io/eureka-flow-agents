# Generate API — WebSocket Result Not Delivered (Backend Escalation)

**Status:** Frontend implementation complete and tested against the documented contract. No final
`GenerateResponse` frame was observed on the WebSocket connection during verification.

## 1. Steps to reproduce

1. Start the web app with:
    ```
    VITE_API_URL=https://api.eureka.codes/flw-d1
    VITE_WS_ENDPOINT=wss://wss.eureka.codes/wss-d1
    VITE_AGENT_GATEWAY=generate-ws
    ```
2. Open a flow in the editor. Confirm the FlowAgentPanel subtitle reads _"Real Generate gateway
   (WebSocket) enabled..."_ — confirms the WS gateway path is selected.
3. Open Chrome DevTools → Network → WS → the `wss-d1` connection → **Messages** tab (raw frames).
4. Send any message in the FlowAgentPanel chat (e.g. "hello").
5. Watch the Messages tab for several minutes.

## 2. Expected result

Per the Generate API spec:

1. `POST {API_URL}/_api_/runs/0/generate?connection=<connectionId>&transport=1` returns an ACK.
2. Shortly after, a `GenerateResponse` object (containing `output.content`, the model's actual
   answer) is pushed to the client over the **same WebSocket connection** used to obtain
   `connectionId`.
3. The frontend renders that pushed result in the chat panel.

## 3. Actual result

1. **HTTP ACK is correct**: `POST /runs/0/generate?connection=<connectionId>&transport=1` returns
   **HTTP 202**, with `output.content` empty — matching the spec's `GenerateAck` shape exactly
   (`transport: true`, empty `text`/`output.content`, not meant to be rendered as the result).
2. **The WebSocket connection is healthy**: status **101** (successful upgrade), confirmed alive
   for the full duration of the test.
3. **No result frame ever arrives.** Over several minutes on the same connection, the WS Messages
   tab shows only:
    - `action: info` (the initial connection-info frame)
    - `system ping` / `pong` heartbeat frames

    No frame containing `output` or any `GenerateResponse`-shaped payload was observed for the
    `connectionId` used in the request.

Frontend-side verification did not observe any final `GenerateResponse` frame after the ACK. The
frontend builds the request with the documented `connection`/`transport` params, registers a
receiver for that exact `connectionId` _before_ the request is sent, and remains actively listening
on the same live WS connection throughout the wait window.

## 4. Evidence to attach

- [ ] Screenshot of the Network tab request: URL showing `connection=<connectionId>&transport=1`,
      status `202`, response body (empty `output.content`).
- [ ] Screenshot of the WS Messages tab spanning the full wait window — showing only
      `info`/`ping`/`pong`, nothing else, with timestamps proving several minutes elapsed after the
      POST fired.
- [ ] The `info` frame's `data.connectionId` value, side-by-side with the `connection=` query
      param from the POST request — to rule out an identifier mismatch (confirm they're identical).
- [ ] Browser console screenshot showing `[GenerateApiLlmGateway] chat() reached { isConnected:
  true, connectionId: "...", hasGenerateReceiver: true }` — confirms the frontend reached the
      point of registering the receiver and firing the request.
- [ ] (Optional, once ~60s pass) the panel's timeout error message — the frontend now fails
      gracefully with _"Generate result timed out after 60000ms — no WebSocket frame arrived"_
      rather than hanging forever, which itself is evidence nothing arrived in that window.

## 5. Frontend implementation status

The receiver-side implementation is complete, per the current spec (a single `GenerateResponse`
object over the socket — not a chunked/streaming protocol):

- `useGenerateReceiver` ([useGenerateReceiver.ts](../../../apps/web/src/app/features/flows/hooks/useGenerateReceiver.ts)) registers interest for a `connectionId` **before** the HTTP POST fires, resolves on the first matching frame, has a 60s timeout, and cancels all in-flight waits (visibly, no auto-retry) if the socket disconnects mid-request.
- `parseWebSocketMessage` ([useInitFlowSocket.ts](../../../libs/socket/src/hooks/useInitFlowSocket.ts)) recognizes a Generate result structurally (`connectionId` + `output` fields), not by a guessed action name, so it isn't dependent on a specific frame-type string the backend may or may not use.
- Fully wired from `FlowEditorPage` → `FlowAgentPanel` → `createGenerateApiLlmGateway`, gated behind `VITE_AGENT_GATEWAY=generate-ws`, additive to the existing (working) sync path.
- **Tests are green**: `nx test web` — 17/17 files, 147/147 tests, including dedicated coverage for the receiver (registers-before-fire, resolves-on-frame, timeout, cancel-on-disconnect, drops-unregistered-frames). `nx test agent` — 16/17 files, 153/155 (2 skipped, real-provider-only, unrelated). Lint clean.

Full implementation notes: [`websocket-generate-receiver-implementation.md`](websocket-generate-receiver-implementation.md).

## 6. Summary for backend/API

The HTTP side of the contract is confirmed correct and working (`202` ACK, correct params, correct
auth). **No final `GenerateResponse` frame was observed on the WebSocket side** — the connection is
alive and otherwise functioning (heartbeats present), but nothing beyond `info`/`ping`/`pong` was
seen for a Generate request's `connectionId` during the verification window.

This reproduces and confirms the same gap recorded earlier in
[`websocket-generate-verification.md`](websocket-generate-verification.md) — this time against the
fully-specified contract (single `GenerateResponse` object, not the previously-assumed chunked
`json:manifest`/`json:chunk`/`json:complete` frames), ruling out "wrong frame shape" as the cause.
The open questions from that doc's §6 still stand and need backend confirmation:

1. Does `transport=1` actually trigger a WS push today, or is that wiring not yet implemented
   server-side?
2. Which connection identifier is used for the push — `connectionId` or the sockets-api record
   `id`? (Both were tested in the earlier verification pass with no difference.)
3. Is the push per-connection or per-channel? `/runs/0/generate` is a standalone run with no flow
   channel, so per-connection push appears to be the only viable route unless a channel param is
   required and undocumented.
