# WebSocket/SLS Generate Path — Verification (Backend-Blocked)

## 1. Scope

A discovery/manual smoke-test pass, not an implementation. Goal: determine whether the
existing WebSocket/SLS Generate gateway (`createGenerateApiLlmGateway`) can receive a final
Generate result over the app's live WebSocket today, or whether it is blocked on a backend
contract that does not exist yet.

**Outcome: backend/contract blocked.** No `GenerateReceiver` was implemented, and none
should be until the questions in §6 are answered.

## 2. What was already known

- The **sync / non-WebSocket path is done and working** — `POST /runs/0/generate` with no
  `transport` returns the final model text inline (see `llm-gateway.md` §6.1).
- `createGenerateApiLlmGateway` is the receiver-based WebSocket/SLS variant. It posts
  `POST /runs/0/generate?connection=<connectionId>&transport=1` and awaits a
  `GenerateReceiver.wait(connectionId, fire)` that no socket-layer code implements yet.
- An earlier smoke test with `transport=1` saw only an async ACK and no final result.

## 3. Client-side causes investigated first

Before calling this backend-blocked, the plausible frontend causes were checked in code:

- **App parser hiding frames — ruled out.** `parseWebSocketMessage` (in
  `libs/socket/src/hooks/useInitFlowSocket.ts`) drops any frame lacking `id`/`nodeId`
  before it reaches React state, the store, or the dev socket panel. But observation was
  done in **Chrome DevTools → Network → WS → Messages**, which shows raw frames _before_
  any app parsing. Nothing was hidden by the client.
- **Which identifier `connection=` wants — genuinely ambiguous, so both were tested.** The
  `info` frame exposes two distinct values: `data.id` (a hex record id, e.g.
  `814e…`) and `data.connectionId` (an AWS-style id, e.g. `gU5V…==`).
  `eureka-sockets-api`'s `ConnectionModel` labels its record `id` **"as `conn-id`"** while
  `connectionId` is "The unique identifier for the WebSocket connection"; the record also
  carries `apiId`/`stage`/`domain`, which a backend needs to build an AWS Management API
  endpoint for a push. `eureka-flows-api`'s `doPostRunParam.connection` is documented only
  as "web-socket connection-id … 연결ID (see `eureka-sockets-api`)" — which does not
  disambiguate the two. The app's own working flow/node run path (`runNode`/`runFlow`)
  sends `connection=<data.connectionId>`, but those run events may arrive via **channel**
  subscription rather than per-connection push, so per-connection push had never actually
  been proven. Both identifiers were therefore tested.
- **`transport` is undocumented.** It appears nowhere in `eureka-flows-api`'s types (not in
  `doPostRunParam`), so its valid values cannot be derived from code — only probed.

## 4. Variants tested

All against the real dev backend (`flw-d1` / `wss-d1`), same body and sentinel prompt each
time, with the live socket connected and raw WS Messages watched for several minutes.

| Variant | Query params                                         | HTTP | `StatusCode` | `output.content` / `text` | Sentinel in HTTP body |
| ------- | ---------------------------------------------------- | ---- | ------------ | ------------------------- | --------------------- |
| A       | `connection=<connectionId>&transport=1`              | 200  | 202          | empty                     | no                    |
| B       | `connection=<recordId>&transport=1`                  | 200  | 202          | empty                     | no                    |
| C       | `connectionId=<connectionId>&transport=1`            | 200  | —            | empty                     | no                    |
| D       | `connectionId=<recordId>&transport=1`                | 200  | —            | empty                     | no                    |
| E       | `connection=<connectionId>&channel=0000&transport=1` | 200  | 202          | empty                     | no                    |
| F       | `connection=<connectionId>&transport=ws`             | 200  | —            | **populated**             | **yes**               |
| G       | `connection=<connectionId>&transport=sls`            | 200  | —            | **populated**             | **yes**               |
| H       | `connection=<connectionId>` (no `transport`)         | 200  | —            | **populated**             | **yes**               |

## 5. Results

- **No WS frame ever arrived.** Raw WebSocket Messages showed only `info` and ping/pong
  heartbeat frames throughout. No `generate` / `result` / `chunk` / `complete` frame, and
  **no frame containing the sentinel**, for any variant.
- **`transport=1` is what switches the endpoint to async**, independent of the connection
  param: A/B/C/D/E all returned an empty inline body. Notably C/D did so too, even though
  `connectionId=` is (apparently) not the recognized param name — so the async switch is
  driven by `transport=1` alone and is **not gated on supplying a resolvable connection**.
- **`transport=ws` and `transport=sls` are not async modes** — F/G fell back to sync
  behavior and returned the sentinel inline, i.e. those values are not recognized triggers.
- **The sync path, auth, model, and socket are all healthy** — H returned the sentinel
  inline, and the socket was connected with a valid `info` frame the whole time.
- **Neither connection identifier made any difference.** `data.connectionId` and
  `data.id` behaved identically (A vs B), as did the alternative param name (C/D) and the
  added `channel=0000` (E).

## 6. Conclusion — backend/contract blocked

The frontend can connect to the WS endpoint and can call `POST /runs/0/generate` with
`transport=1`, but **the async Generate result is not emitted to the observable WebSocket
connection** for either the `connectionId` or the record-`id` variant. Every client-side
hypothesis that could be tested from the browser has been exhausted:

- not hidden by the app's message parser (verified against raw frames),
- not a connection-identifier mismatch (both forms tested),
- not a param-name mismatch (`connection` and `connectionId` both tested),
- not a missing channel param (`channel=0000` tested),
- not a wrong `transport` value among the plausible alternatives (`ws`/`sls` tested, and
  both proved to be sync fallbacks rather than async modes).

**Do not implement `GenerateReceiver` yet.** There is no observable frame to receive, and
its shape/action is unknown — any receiver written now would be speculation. The WS/SLS
gateway (`createGenerateApiLlmGateway`) stays as-is: still receiver-injected, still
fake-tested only, still not wired into any panel. The sync gateway
(`createGenerateApiSyncLlmGateway`) remains the working real path.

### Questions needing backend / Claire confirmation

1. **Should `transport=1` emit a final WS frame at all?** (It currently returns
   `StatusCode: 202` and nothing further is observed.)
2. **Which connection identifier should be used** — `data.connectionId` (AWS-style) or
   `data.id` (the sockets-api record "conn-id")?
3. **What is the final frame's shape/action?** (e.g. an `action` value and payload
   envelope the client can recognize and route.)
4. **Is standalone `/runs/0/generate` supposed to push by connection, by channel, or is
   this simply not implemented yet?** Note `/runs/0/...` is a standalone run with no flow
   channel for the browser to be subscribed to, so per-connection push appears to be the
   only viable delivery route unless a channel is specified.

### Known frontend follow-up, once the contract is confirmed

Even after the backend emits a frame, `parseWebSocketMessage` will **drop it** unless it
carries an `id`/`nodeId`. That parser gate is a small, known frontend change to make at
implementation time — it is not the current blocker, but it will need handling.

## 7. Security note

No API key, raw WebSocket URL, or `x-api-key` value appears in this document or was
printed during testing. Smoke calls passed `x-api-key` as a request header only, read from
the browser session; identifiers shown above are truncated examples. WebSocket worker logs
were separately redacted (see commit `fix(socket): redact websocket auth logs`).
