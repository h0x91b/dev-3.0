# dev3 remote protocol

This document freezes the wire contract implemented by the current remote server. It is the compatibility boundary for native clients; when prose and code disagree, the contract tests and the linked source are authoritative.

## Transport and compatibility

- The client pairs with an origin, for example `http://192.168.1.20:4242` or `https://example.trycloudflare.com`. HTTP requests and WebSockets use that same origin.
- Browser `Origin` headers must have the same host and port as the request `Host`; the scheme is not compared. A request without `Origin` is accepted for non-browser clients.
- Authentication is a `dev3_session` cookie on every protected HTTP request and WebSocket upgrade. Native clients store the cookie value in Keychain and send `Cookie: dev3_session=<value>` explicitly.
- Clients must ignore unknown JSON fields and unknown push-message names. Server changes must remain additive unless the `protocolVersion` is deliberately revised.
- `GET /instance` publishes the stable server identity and protocol version used by discovery and compatibility checks.

The server implementation is [`src/bun/remote-access-server.ts`](../../src/bun/remote-access-server.ts). RPC method and payload types are defined by `AppRPCSchema` in [`src/shared/types.ts`](../../src/shared/types.ts).

## Authentication

QR URLs have the form `<origin>/?token=<credential>`. In normal operation the credential is an HMAC-SHA256 JWT with `type: "qr"`, a 30-second lifetime, and a one-use `jti`. In development, `DEV3_REMOTE_STATIC_CODE` replaces the one-use JWT with a fixed code.

### `POST /auth/exchange`

Request:

```http
POST /auth/exchange
Content-Type: application/json

{"token":"<QR JWT or static code>","client":"ios"}
```

`token` is required. A native client may request a 30-day rolling session with `"client":"ios"`, but the server honors that marker only when the HTTP request has no `Origin` header. A browser request with the marker still exchanges successfully as an ordinary 24-hour session, preventing browser script from upgrading its own credential. Unknown or absent client markers also select the 24-hour class; even an empty `Origin` header prevents the native upgrade.

| Status | Body | Cookie behavior |
|---|---|---|
| `200` | `{"ok":true}` | Sets a 30-day iOS cookie or 24-hour default cookie |
| `400` | `Missing token` or `Bad request` | None |
| `401` | `Invalid or expired token` | None; an existing valid cookie is not cleared |
| `403` | `Forbidden` | None; browser origin did not match |

When a static code is configured, only that code is accepted; a valid QR JWT cannot bypass it. Successful exchange consumes a QR JWT and a replay returns `401`.

### `POST /auth/refresh`

The request has no body and carries the current session cookie.

| Status | Body | Cookie behavior |
|---|---|---|
| `200` | `{"ok":true}` | Replaces the cookie and rolls its signed client class forward 30 days or 24 hours |
| `401` without a cookie | `Unauthorized` | None |
| `401` with an invalid or expired cookie | `Invalid or expired session` | Clears the cookie with `Max-Age=0` |
| `403` | `Forbidden` | None; browser origin did not match |

A live client refreshes on foreground, after a socket closes, and every 15 minutes while connected. `401` or `403` means the pairing is dead. Network failures enter reconnect backoff instead of deleting the credential.

### Cookie attributes

Default/browser exchange and refresh return:

```text
dev3_session=<session JWT>; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict
```

Native iOS exchange and refresh return the same attributes with `Max-Age=2592000`. The signed iOS JWT carries `client: "ios"`; default/legacy session tokens omit `client`. Refresh reads this signed claim and preserves the class, so a caller cannot upgrade a 24-hour token at refresh time.

The clear cookie has the same attributes with an empty value and `Max-Age=0`. There is deliberately no `Secure` attribute because LAN mode uses plain HTTP. Every session JWT also has `type: "session"`, `iat`, `exp`, and `jti`; its signing secret persists in `~/.dev3.0/remote-jwt-secret`, so sessions survive a normal server restart.

## Instance identity and discovery

`GET /instance` is unauthenticated so a client can identify a discovered service before pairing:

```json
{
  "instanceId":"0190f3d1-0e39-4f72-87a7-48c7a4d93847",
  "name":"Development Mac",
  "appVersion":"1.36.0",
  "protocolVersion":1
}
```

The response is `200 application/json` with `Cache-Control: no-store`. Other methods return `405 Method Not Allowed` and `Allow: GET`. `instanceId` is a persistent UUID stored additively at `~/.dev3.0/remote-instance-id`; `name` defaults to the host name. `protocolVersion` is currently `1` and is the compatibility gate, while `appVersion` is informational.

While the remote server runs, it best-effort advertises `_dev3._tcp` on its actual listen port. DNS-SD TXT records contain `instanceId`, `protocolVersion`, and `appVersion`. Discovery failure never prevents direct remote access, and operators can disable advertisement with `DEV3_REMOTE_NO_MDNS=1`.

## Health probe

`GET /health` requires the session cookie. A valid request returns:

```json
{"ok":true,"ptyPort":43210}
```

`ptyPort` is informational and can be `0` when the internal PTY server is unavailable. An invalid or missing cookie returns `401 Unauthorized`. The handler currently does not restrict the HTTP method, but clients should use `GET`.

## RPC WebSocket

Connect to `<ws-origin>/rpc` with the session cookie. The upgrade can fail with `401 Unauthorized`, `403 Forbidden`, or `400 WebSocket upgrade failed`.

All frames are UTF-8 JSON objects. A client request is:

```json
{"type":"request","id":17,"method":"getProjects","params":null}
```

`id` is client-selected and is echoed unchanged. A monotonic integer is recommended. For methods whose TypeScript `params` type is `void`, send `null` or omit the value according to the client's encoder; handlers do not require a special sentinel.

Success and failure responses are:

```json
{"type":"response","id":17,"success":true,"payload":[]}
{"type":"response","id":18,"success":false,"error":"Unknown RPC method: noSuchMethod"}
```

Thrown values become `error` strings. A request received before the backend handler is installed fails with `RPC handler not ready`. Malformed JSON is logged and produces no response; non-`request` packets from a client are ignored.

The server imposes no request timeout. Native clients should match the browser transport: queue unsent requests until the socket opens, use a 120-second timeout, correlate by `id`, and reject in-flight requests when the socket closes.

The complete method surface and exact parameter/response types are the `AppRPCSchema["bun"]["requests"]` declaration in [`src/shared/types.ts`](../../src/shared/types.ts). The native v1 client intentionally wraps a subset, but it uses the same method names and payloads without a native-only envelope.

### Task creation and launch transaction

Native task creation uses the existing multi-call browser transaction. The initial create is authoritative and must be surfaced locally before optional metadata follow-ups because a new `todo` task does not emit `taskUpdated`.

| Method | Parameters | Response |
|---|---|---|
| `getAgents` | `null` | `CodingAgent[]` |
| `getGlobalSettings` | `null` | `GlobalSettings` |
| `createTask` | `{projectId, description, status?, existingBranch?, scratch?, opsWorkDir?, priority?}` | `Task` |
| `renameTask` | `{taskId, projectId, customTitle: string \| null}` | `Task` |
| `setTaskLabels` | `{taskId, projectId, labelIds: string[]}` | `Task` |
| `toggleTaskWatch` | `{taskId, projectId, watched: boolean}` | `Task` |
| `spawnVariants` | `{taskId, projectId, targetStatus, variants: {agentId: string \| null, configId: string \| null, accountId?: string \| null}[]}` | `Task[]` |

`spawnVariants` consumes the source `todo` task and returns its replacements immediately. For an active target such as `in-progress`, each returned task can still have `preparing: true`; background preparation later emits `taskUpdated`. A client must atomically replace the source locally, then wait until `preparing != true` and `worktreePath` is non-null before attaching its terminal.

Title and labels are deliberately non-transactional follow-ups. Their failure never rolls back or repeats the successful `createTask`. A lost create or spawn response is ambiguous because persistence may already have happened; the client refetches that project and asks the user to inspect the board instead of retrying automatically.

## Server push messages

Every live `/rpc` client receives pushes in this shape:

```json
{"type":"message","id":"taskUpdated","payload":{"projectId":"...","task":{}}}
```

`id` is the event name. Delivery is best-effort to clients connected at emit time. The server has no acknowledgement, queue, sequence number, or replay buffer. After every reconnect, refetch `getProjects` and `getAllProjectTasks` before applying new pushes.

The typed backend catalog is:

| Event | Payload |
|---|---|
| `taskUpdated` | `{projectId, task: Task}` |
| `taskRemoved` | `{projectId, taskId}` |
| `projectUpdated` | `{project: Project}` |
| `taskSound` | `{status: "completed" | "cancelled", taskId}` |
| `ptyDied` | `{taskId}` |
| `projectPtyDied` | `{projectId}` |
| `terminalBell` | `{taskId}` |
| `gitOpCompleted` | `{taskId, projectId, operation, ok}` |
| `updateAvailable` | `{version}` |
| `branchMerged` | `{taskId, projectId, taskTitle, branchName, fingerprint}` |
| `agentCompletionRequested` | `{requestId, taskId, projectId, taskTitle, taskOverview?}` |
| `portsUpdated` | `{taskId, ports: PortInfo[]}` |
| `exposedPortsChanged` | `{taskId, ports: ExposedPort[]}` |
| `resourceUsageUpdated` | `{taskId, usage: ResourceUsage}` |
| `agentRateLimitsUpdated` | `AgentRateLimitsReport` |
| `updateDownloadProgress` | `{status, progress?}` |
| `columnAgentFailed` | `{taskId, projectId, columnName, error}` |
| `taskPreparationFailed` | `{taskId, projectId, taskTitle, error}` |
| `globalSettingsUpdated` | `GlobalSettings` |
| `openTaskFromNotification` | `{taskId, projectId}` |
| `cliToast` | `{taskId, projectId, message, level, durationMs?, taskSeq?, taskTitle?, projectName?}` |
| `cliAttention` | `{taskId, reason}` |
| `webNotification` | `{taskId, projectId, title, body, level, taskSeq?, taskTitle?, projectName?}` |
| `taskPrStatus` | PR identity, CI, review, merge state, checks, title, and draft fields as declared in `AppRPCSchema` |
| `automationsUpdated` | `{projectId}` |
| `automationRunsMissed` | `{projectId, automationId, automationName, missedCount, caughtUp}` |

Remote mode also emits these renderer-directed events over the same transport:

| Event | Payload |
|---|---|
| `osc52Clipboard` | `{taskId, text, len}` |
| `qrTokenConsumed` | `{}` |
| `cliShowImage` | `TerminalFocusImagePayload` |
| `cliShowArtifact` | `TerminalFocusArtifactPayload` |

`cliShowImage` and `cliShowArtifact` are declared in `AppRPCSchema` with their complete task-bound histories and newest-batch counts. Menu- and window-directed desktop events may also cross the generic channel; native clients should ignore names they do not implement.

## PTY WebSocket

Open one socket per visible terminal at:

```text
<ws-origin>/pty?session=<session-id>
```

Task terminals use the raw task ID. Project terminals use `project-<projectId>`. `getPtyUrl({taskId})` and `getProjectPtyUrl({projectId})` remain the canonical way to ensure the session exists; a native client should derive only the origin and cookie handling, not invent a second session ID scheme.

The upgrade requires the session cookie and same-origin browser header. Missing auth returns `401`, an origin mismatch returns `403`, a missing `session` query returns HTTP `400 Missing session param`, and a failed upgrade returns HTTP `400 WebSocket upgrade failed`.

### Data and input

- Server-to-client frames are a fully rendered VT/xterm UTF-8 stream from a shared tmux attach client. This is not tmux control mode and there is no application JSON envelope.
- Ordinary client-to-server frames are decoded as UTF-8 and written to the PTY exactly as received.
- Client frames received after the remote socket opens but before its localhost PTY upstream finishes connecting are queued and flushed in FIFO order. The pre-open queue is bounded to 64 frames and 256 KiB; exceeding either limit clears the queue and closes the remote socket with `4003 PTY input queue overflow`. Upstream or downstream close/error also clears pending input.
- Resize is an OSC-shaped text control frame terminated by BEL:

  ```text
  ESC ] resize ; <positive-cols> ; <positive-rows> BEL
  \x1b]resize;<cols>;<rows>\x07
  ```

  The parser accepts decimal digits. A frame that starts with the resize prefix is consumed even when malformed and is not forwarded as terminal input.
- Output is server-batched on a roughly 16 ms cadence. Clients may additionally coalesce terminal rendering to display refresh.

### Shared size negotiation

Every client reports its last size. The shared PTY uses the minimum positive column count and minimum positive row count independently across attached clients. A client that has not reported a size is ignored. Disconnecting a constraining client lets the PTY grow to the minimum of the remaining viewers. Consequently, attaching a phone can shrink the desktop terminal; v1 accepts this existing behavior.

### OSC 52 clipboard

The PTY server recognizes OSC 52 sequences terminated by BEL or ST, buffers a sequence split across output chunks, removes it from visible PTY output, decodes the Base64 UTF-8 text, and emits `osc52Clipboard` on `/rpc`. Queries (`?`), empty data, and malformed data are ignored. Clipboard data therefore never arrives as a `/pty` frame.

### Close and failure behavior

| Code or response | Meaning | Observable at remote `/pty` client |
|---|---|---|
| HTTP `400` | Missing `session` query | Yes, before WebSocket upgrade |
| `4000 Missing session parameter` | Internal PTY socket opened without a session | Forwarded unchanged if emitted; remote requests without `session` fail as HTTP `400` before upgrade |
| `4001 Unknown session` | Internal PTY session does not exist | Forwarded unchanged with its reason |
| `4002 PTY server not available` | Remote proxy has no internal PTY port | Emitted by the proxy, or forwarded unchanged from upstream |
| `4003 PTY upstream error` or `PTY input queue overflow` | Remote proxy could not use the upstream socket, or its bounded pre-open input queue overflowed | Emitted by the proxy, or forwarded unchanged from upstream |

The remote proxy preserves upstream application close codes `4000`–`4003` and their reason strings verbatim; other upstream closes remain generic downstream disconnects. Clients must still handle every WebSocket close, including a close without an application code. Codes `4002` and `4003` are retryable availability failures. Code `4001` means the client must resolve the unknown/dead session through `getPtyUrl`, `resumeTask`, or `restartTask` before reconnecting.

## Reconnection sequence

1. On foreground, network-path change, or socket close, call `POST /auth/refresh` with the stored cookie.
2. On `200`, replace the stored cookie, reconnect `/rpc`, then refetch `getProjects` and `getAllProjectTasks` because pushes were not replayed.
3. Reopen only the currently visible `/pty` connection and immediately send its resize frame.
4. On `401` or `403`, discard the session and require pairing. On transport failure, retain the credential and retry with exponential backoff from 2 seconds up to 15 seconds.
