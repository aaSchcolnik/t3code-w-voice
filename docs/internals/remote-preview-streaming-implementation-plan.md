# Remote preview streaming — implementation plan

Branch: `feat/remote-preview-streaming`. Tracking: this document until a GitHub
issue owns it.

## Problem

The preview browser lives inside the Electron desktop app as a renderer-owned
`<webview>`. Agents drive it over Chrome DevTools Protocol from the main
process, and the desktop user sees it in the Browser tab or the in-app mini
player. Every other client is locked out: the web client shows "Only available
in the desktop app" (`apps/web/src/components/RightPanelTabs.tsx`) and mobile
has no preview surface at all.

A user working from an iPad connected to the same T3 environment (over LAN,
Tailscale, or T3 Connect) needs to see the preview live and click, scroll, and
type into it, so the same tab the agent automates can also be tested by a
human without sitting at the Mac. The stream must be cheap enough to work on
every connection mode and responsive enough that it never feels like a laggy
remote desktop. The Browser tab and the mini player must both keep working on
the iPad.

## What already exists

Facts verified in the tree at `9267ecf6dd`, plus two independent design
reviews (Codex GPT-5.6 and Antigravity Gemini 3.8) of the approach below.

- **Guest hosting.** `apps/web/src/browser/HostedBrowserWebview.tsx` renders
  the `<webview>`; main holds it by `webContentsId`
  (`apps/desktop/src/preview/Manager.ts`, `registerWebview`). Both the Browser
  panel and `ThreadPreviewMiniPlayer.tsx` are `BrowserSurfaceSlot`
  placeholders; one `ElectronBrowserHost` positions the real webview over
  whichever slot holds the lease (`browserSurfaceStore.ts`). Off-Electron the
  host returns `null`.
- **Tab MediaStream.** Recording arms a tab in main and answers the renderer's
  `getDisplayMedia()` through `session.setDisplayMediaRequestHandler` with
  `{ video: guest.mainFrame }` (`Manager.ts` `startRecording`,
  `installDisplayMediaRequestHandler`). The renderer feeds it to
  `MediaRecorder` in `apps/web/src/browser/browserRecording.ts`. The arm is
  one-shot and checks the requesting frame id.
- **CDP control session.** One `webContents.debugger` session per guest,
  serialized by a semaphore, invalidated by `controlEpochRef` when a human
  touches the guest (`PickPreload.ts` → `HUMAN_INPUT_CHANNEL` →
  `handleHumanInput`). Agent routines: click sleeps 160 ms + 40 ms for the
  cursor animation, scroll is an instant `scrollBy`, type is bulk DOM editing
  because `Input.insertText` drops text before the guest has seen a pointer.
- **Server → client requests.** `PreviewAutomationBroker` streams requests to
  Electron hosts over `previewAutomation.connect` and pairs responses by
  `requestId`. Only Electron renderers register (`PreviewAutomationHosts.tsx`).
- **Transport.** WS RPC is JSON (`RpcSerialization.layerJson`), deflate on, no
  backpressure. T3 Connect is a `cloudflared` catch-all origin tunnel: any new
  HTTP or WS route passes through; UDP does not. The relay Worker lives in
  `infra/relay/` and already mints credentials for T3 Connect clients.
- **Runtimes.** Electron 43.4.1 = Chromium 150. iPad Safari decodes H.264 in
  hardware and WKWebView supports WebRTC. `react-native-webview` is already a
  mobile dependency.

## Decision

**Video over WebRTC, input over WebRTC DataChannels, sessions and signaling
over the existing WS RPC.**

- Video: the tab `MediaStream` the recording path already obtains, sent as an
  H.264 track with `contentHint = "detail"`. Adaptive bitrate is what makes
  "any connection" true without a hand-rolled rate controller. Idle pages cost
  tens of kbps; scrolling 0.5–3 Mbps; glass-to-glass 50–150 ms on LAN.
- Input: **not** the agent automation routines. A dedicated human-input path
  in main that bumps the control epoch first, bypasses the agent semaphore,
  and dispatches real CDP touch, mouse, wheel, and key events. Carried on two
  DataChannels so the server is not in the per-event path.
- Sessions: a new `RemotePreviewSessionBroker` on the server owns viewer and
  controller leases, signaling relay, authorization, and revocation. It borrows
  host selection from `PreviewAutomationBroker` but not its provider-session
  stickiness or unbounded queue.
- Rejected: JPEG frames over WS (5–15 Mbps while scrolling, base64 JSON on the
  RPC socket) and WebCodecs H.264 over a binary WS route (re-implements
  congestion control and recovery; TCP head-of-line blocking on lossy links).

## Architecture

```
iPad web client (Safari / WKWebView)                Mac
┌────────────────────────────────┐    WS RPC     ┌───────────────────────────────┐
│ RemoteBrowserHost              │◄────────────►│ T3 server                      │
│  <video> over BrowserSurfaceSlot│  signaling,   │  RemotePreviewSessionBroker    │
│  hidden <textarea> for keyboard │  leases,      │   leases, authz, TURN creds    │
│  pointer/touch/key capture      │  revocation   └──────────────┬────────────────┘
└──────────────┬─────────────────┘                              │ WS RPC (stream)
               │ WebRTC: video + 2 DataChannels                  ▼
               │  (direct on LAN/Tailscale, TURN on T3 Connect) ┌───────────────────────────────┐
               └───────────────────────────────────────────────►│ Electron renderer             │
                                                                │  RemotePreviewPeer            │
                                                                │   getDisplayMedia(tab) → track │
                                                                │   DataChannel → IPC           │
                                                                └──────────────┬────────────────┘
                                                                               │ IPC
                                                                               ▼
                                                                ┌───────────────────────────────┐
                                                                │ Electron main: Manager.ts     │
                                                                │  HumanInputDispatcher (CDP)   │
                                                                │  capture lease, viewer state  │
                                                                └───────────────────────────────┘
```

Roles per tab: any number of **viewers** (read-only, capped) and at most one
**controller**. Precedence: local desktop user > remote controller > agent.

## Contracts (`packages/contracts`)

New file `packages/contracts/src/remotePreview.ts`, exported from `index.ts`.

- `RemotePreviewRole = "viewer" | "controller"`.
- `RemotePreviewSessionId`, `RemotePreviewGeneration` (bumps on ICE restart,
  guest recreation, and host reconnect).
- `RemotePreviewSourceMetadata`: `cssWidth`, `cssHeight`, `deviceScaleFactor`,
  `zoomFactor`, `generation`. This, never the encoded frame size, is the
  coordinate basis.
- Signaling payloads: `offer`, `answer`, `iceCandidate`, `iceRestart`, each
  carrying `sessionId` and `generation`.
- `RemotePreviewTurnCredentials`: `urls`, `username`, `credential`,
  `expiresAt`.
- DataChannel message schemas (encoded as JSON on the channel, small and
  per-event; binary packing is a later optimization):
  - reliable channel `control`: `pointerDown`, `pointerUp`, `tap`,
    `touchStart`, `touchEnd`, `keyDown`, `keyUp`, `insertText`,
    `compositionCommit`, `focusRequest`, `releaseAll`, `viewportAck`.
  - unreliable channel `motion`: `pointerMove`, `touchMove`, `wheel`, each
    with a monotonically increasing `sequence`; receivers drop stale sequences.
- Server-side events streamed to the viewer: `sourceMetadata`,
  `controllerChanged`, `hostState` (`streaming | paused | devtools |
  popup-open | crashed | host-gone`), `agentPointer` (forwarded
  `DesktopPreviewPointerEvent`).
- Errors: `RemotePreviewNoHostError`, `RemotePreviewControllerBusyError`,
  `RemotePreviewViewerLimitError`, `RemotePreviewRevokedError`,
  `RemotePreviewDevToolsOpenError`.

`packages/contracts/src/rpc.ts` gains `WS_METHODS.remotePreview*`:
`open` (stream: session events + signaling from the host), `signal` (unary,
client → host), `requestControl`, `releaseControl`, `close`, and the host-side
`hostConnect` (stream: requests to the Electron renderer) and `hostSignal`.

`packages/contracts/src/auth.ts` gains `AuthPreviewViewScope =
"preview:view"` and `AuthPreviewControlScope = "preview:control"`. Existing
preview RPCs stay on `orchestration:operate`; the new ones map to the two new
scopes in `apps/server/src/auth/RpcAuthorization.ts`. Standard pairing tokens
carry both; a view-only token is possible but not a v1 UI.

`packages/contracts/src/ipc.ts` gains the desktop bridge surface:
`preview.remote.startCapture(tabId)`, `stopCapture(tabId)`,
`dispatchInput(tabId, message)`, `readSourceMetadata(tabId)`,
`onSourceMetadata`, `onHostState`.

## Server (`apps/server`)

New `apps/server/src/preview/RemotePreviewSessionBroker.ts` (Effect service,
same shape as `PreviewAutomationBroker`).

- State per session: `environmentId`, authenticated client session id,
  `threadId`, `tabId`, host connection id, role, `generation`, `expiresAt`,
  DTLS fingerprint once the answer arrives.
- Host selection: filter hosts by `environmentId` that advertise the
  `remotePreview` capability, prefer focused, then most recently focused. No
  provider-session stickiness. Bind the session to the explicit `tabId`; never
  follow the desktop's active tab.
- Leases: `viewer` grants are capped (`REMOTE_PREVIEW_MAX_VIEWERS = 2` per tab
  to start); `controller` is exclusive. `requestControl` on a busy tab fails
  with `RemotePreviewControllerBusyError` and the UI offers "take over", which
  revokes the other controller through its stream.
- Signaling: relay `offer`/`answer`/`iceCandidate` between viewer and host
  without inspecting SDP beyond rejecting a `viewer` answer that adds a
  `control` DataChannel (m-line check on the data section label).
- Revocation: when the client session is revoked or its WS closes, send
  `close` to the host so the desktop tears down the peer. A live DataChannel
  cannot notice its WS credential died on its own.
- TURN: `mintTurnCredentials(sessionId)` calls the relay Worker only for
  `RelayConnectionTarget` sessions, after authorization succeeds, with a
  10-minute TTL and one mint per session per 5 minutes. Direct and Tailscale
  sessions get an empty ICE server list.
- Queue bound: `Queue.sliding(64)` for host request streams; signaling is
  small and a lost stale candidate is recoverable by ICE restart.

`infra/relay/`: add a `POST /turn/credentials` route on the Worker that wraps
Cloudflare Realtime TURN key → short-lived credential minting, authorized by
the environment's existing relay credential. Document the Cloudflare account
prerequisite in `infra/relay/README.md`.

Tests (`apps/server/src/preview/RemotePreviewSessionBroker.test.ts`): lease
exclusivity and takeover, viewer cap, host selection by environment, session
close on client revocation, generation bump on host reconnect, view-only
answer rejected when it adds a control channel. Wait on receipts, no sleeps.

## Desktop main (`apps/desktop`)

`apps/desktop/src/preview/Manager.ts`:

- Add `"remote-view"` to `FrameCaptureConsumer`. Share one captured stream
  between `recording` and `remote-view`: `startRemoteCapture(tabId)` reuses
  `startRecording`'s arm-and-grant flow, and the renderer keeps a single
  `MediaStream` per tab that both `MediaRecorder` and the peer consume. Keep
  the one-shot, frame-id-checked arming exactly as it is.
- `powerSaveBlocker.start("prevent-display-sleep")` while any remote-view
  consumer is active; stop when the last one ends. Keep the guest unthrottled
  the same way recording does.
- New `apps/desktop/src/preview/HumanInputDispatcher.ts`, invoked by Manager
  through the existing control session's `send` but **outside**
  `withControlSession`'s agent semaphore:
  - On the first message of a controller session, bump `controlEpochRef`
    (reuse the `handleHumanInput` path) so in-flight agent actions abort with
    `PreviewAutomationControlInterruptedError`.
  - Finger input → `Input.dispatchTouchEvent` sequences. Pencil, trackpad, and
    mouse → `Input.dispatchMouseEvent`. Hover only from those, never from a
    finger.
  - Wheel → `Input.dispatchMouseEvent` type `mouseWheel` with deltas; the
    viewer sends momentum deltas after release so scrolling matches touch.
  - Keys → `Input.dispatchKeyEvent` with `text` for printable keys; iPad
    Command maps to `Meta`. `insertText`/`compositionCommit` →
    `Input.insertText`. Spike first: confirm `insertText` works once a remote
    pointer event has activated the guest (the recorded bug in
    `automationType` is pre-activation). If it still drops, fall back to the
    existing `typeIntoAutomationTarget` helper for committed text only.
  - `releaseAll` → synthesize `mouseReleased`, `touchEnd`, and `keyUp` for
    every held input. Called on ICE restart, controller change, viewer
    background, and peer close.
  - Coordinates arrive in guest CSS px already; reject points outside
    `sourceMetadata` bounds and drop any message whose `generation` is stale.
- Source metadata: read `cssWidth/cssHeight` with
  `Page.getLayoutMetrics` (or the existing renderer viewport read),
  `zoomFactor` from the tab, `deviceScaleFactor` from the guest. Emit on
  webview register, resize, zoom change, and guest recreation, each with a new
  `generation`.
- DevTools: if `wc.isDevToolsOpened()` the control session cannot attach, so
  emit `hostState: "devtools"` and the viewer becomes read-only. Streaming is
  unaffected because capture does not use CDP.
- Popups: OAuth windows are separate `BrowserWindow`s created by the guest's
  window-open handler and are not in the stream. Emit `hostState:
  "popup-open"` while one exists so the viewer can show "Finish this on the
  desktop". Popup capture is explicitly out of scope for v1.
- Crash recovery: `HostedBrowserWebview.tsx` recreates the guest on
  `render-process-gone`. On re-register with a new `webContentsId`, bump
  `generation`, re-arm capture, and notify the renderer to replace the ended
  track via `RTCRtpSender.replaceTrack`.
- Forward `DesktopPreviewPointerEvent` (agent cursor) to the renderer as
  today; the renderer relays it over the reliable channel so the iPad shows
  the agent cursor.
- Desktop indicator: expose viewer count and controller identity through
  `PREVIEW_STATE_CHANGE_CHANNEL`; the desktop Browser chrome row shows a
  persistent "Remote: 1 viewer, controlled by iPad" pill while active.

IPC: new channels in `apps/desktop/src/ipc/channels.ts`
(`PREVIEW_REMOTE_START_CAPTURE_CHANNEL`, `..._STOP_CAPTURE_CHANNEL`,
`..._DISPATCH_INPUT_CHANNEL`, `..._SOURCE_METADATA_CHANNEL`,
`..._HOST_STATE_CHANNEL`), methods in `apps/desktop/src/ipc/methods/preview.ts`,
bridge in `apps/desktop/src/preload.ts`.

Tests (`Manager.test.ts`): epoch bump on first controller message, touch vs
mouse routing by pointer type, stale-generation drop, `releaseAll`
synthesis, shared capture lease refcount across recording and remote view,
power-save blocker lifecycle.

## Desktop renderer (`apps/web`, Electron only)

New `apps/web/src/components/preview/RemotePreviewHost.tsx` mounted next to
`PreviewAutomationHosts`, one per connected environment, only when
`isElectron`. Registers as a `remotePreview` host over `remotePreview.hostConnect`.

New `apps/web/src/browser/remotePreviewPeer.ts`:

- On a `start` request: acquire the tab `MediaStream` via the shared capture
  helper (refactor `browserRecording.ts` so `prepareTabMediaCapture` is
  shared and refcounted), create `RTCPeerConnection`, add the video track with
  `contentHint = "detail"`, prefer H.264 with
  `RTCRtpTransceiver.setCodecPreferences`, create the `control` (ordered,
  reliable) and `motion` (unordered, `maxRetransmits: 0`) DataChannels, send
  the offer over `hostSignal`.
- Sender policy: `setParameters` with `maxBitrate` 2.5 Mbps and
  `scaleResolutionDownBy` so the encoded frame never exceeds the source CSS
  size × 1 (no 2x backing scale by default); `maxFramerate` 30 while a
  controller is active, 10 when only viewers are attached and no input has
  arrived for 2 s. Read `getStats()` once per 5 s and log the negotiated codec
  and encoder implementation so hardware encode is verified, not assumed.
- Route DataChannel messages to `desktopBridge.preview.remote.dispatchInput`.
  Coalesce `motion` messages to one per animation frame before forwarding.
- Relay `sourceMetadata`, `hostState`, and agent pointer events over the
  `control` channel.
- On `iceRestart` or `iceConnectionState === "failed"`: send `releaseAll`
  locally, `restartIce()`, new `generation`.
- One peer per viewer; the broker caps viewers so the encoder count stays
  bounded.

## iPad web client (`apps/web`, non-Electron)

- Gate: `isPreviewSupportedInRuntime()` in `previewStateStore.ts` becomes
  "Electron bridge present **or** a `remotePreview` host is connected for this
  environment". Surface host presence in the environment's server-config or
  preview events stream. `RightPanelTabs.tsx` copy changes to "Waiting for the
  desktop app on <environment>" when no host is connected.
- New `apps/web/src/browser/RemoteBrowserHost.tsx`: the non-Electron sibling of
  `ElectronBrowserHost`. One instance per active session that positions a
  `position: fixed` container over the leased `BrowserSurfaceSlot` rect, so
  the Browser panel and `ThreadPreviewMiniPlayer` both work unchanged.
  Contents: `<video autoplay muted playsinline>` with `object-fit: contain`, a
  transparent input-capture layer, a hidden `<textarea>` for the keyboard, the
  existing `AgentBrowserCursor` fed from relayed pointer events, and a status
  overlay for `hostState`.
- New `apps/web/src/browser/remotePreviewViewer.ts`: opens `remotePreview.open`,
  answers the host's offer, applies TURN servers if provided, opens the two
  DataChannels, and exposes `sendControl` / `sendMotion`.
- Coordinate mapping (`remotePreviewCoordinates.ts`, pure, unit-tested): map a
  pointer position on the video element to guest CSS px using the displayed
  content rect from `object-fit: contain` and the current `sourceMetadata`.
  Reject points in the letterbox bars. Freeze input while
  `video.videoWidth/Height` and the latest metadata `generation` disagree
  (guest resize in flight).
- Touch model: one-finger pan → `touchMove` stream, then synthesized momentum
  `wheel` deltas after release using a simple decay curve. Tap → `touchStart`
  + `touchEnd`. Long press → `touchStart` held, `touchEnd` on lift; Chromium
  handles the long-press timing. Two-finger pinch → zoom the local video
  (CSS transform on the container, mapping updated accordingly), never the
  remote page. Pencil and trackpad pointers → mouse events with hover.
- Keyboard: hardware keyboard events on the capture layer map directly. The
  on-screen keyboard cannot be raised by a remote focus, so a keyboard button
  in the chrome row focuses the hidden textarea on a local gesture; the
  textarea forwards `beforeinput`/`input` as `insertText`, composition end as
  `compositionCommit`, and Backspace/Enter/arrow keys as key events. Show the
  button prominently when `hostState` reports a focused editable element.
- Control lease UI: viewer joins read-only; tapping the surface requests
  control. If busy, show who holds it and offer take-over. On
  `visibilitychange` hidden → release control and send `releaseAll`; pause
  the video; on visible → resume and renegotiate if the peer failed.
- Fullscreen: iPad-local fullscreen of the video container only. Never ask the
  remote page to enter fullscreen.
- Low Power Mode and poor links: rely on WebRTC's adaptation; expose the
  current bitrate and fps in the "more" menu for debugging.

Unit tests: coordinate mapping incl. letterbox and pinch transform, momentum
curve, stale-generation freeze, textarea → message translation. No rendering
components to static markup.

## Mobile (`apps/mobile`)

Phase-gated after web works. One singleton viewer `WebView`
(`react-native-webview`) positioned over a native slot that mirrors the web
lease model, so the panel and a future mini player share one peer session.
The WebView loads a viewer page served by the T3 server at
`/remote-preview/viewer` with a signed, short-lived token in the path (same
scheme as `AssetAccess`), and the page reuses `remotePreviewViewer.ts` and the
hidden-textarea keyboard handling. `originWhitelist` restricted to the
environment origin; `mediaPlaybackRequiresUserAction={false}`;
`allowsInlineMediaPlayback`. Add a Browser entry to the thread aux pane on
tablet layouts (`apps/mobile/src/lib/layout.ts` breakpoints already gate the
third pane).

## Provider adapters

No adapter changes. Agents keep using `preview_*` MCP tools; remote human
input interrupts them through the existing control epoch exactly like local
human input does. `docs/user/tool-activity.md` gets a note that a remote
controller taking over aborts the agent's in-flight browser step.

## Phases

1. **Spike (1–2 days).** In the Electron renderer, feed the recording
   `MediaStream` into an `RTCPeerConnection` to a second tab on the same
   Mac; verify hardware H.264 via `getStats()`. Confirm `Input.insertText`
   post-activation. Confirm compositing continues with the lid closed under
   `powerSaveBlocker`. Go/no-go on the encoder and sleep behavior.
2. **Watch-only.** Contracts, broker, host registration, capture sharing,
   `RemoteBrowserHost` with video over the surface slot, tab unlock on web,
   desktop remote-viewer indicator. LAN and Tailscale only. Mini player
   verified.
3. **Control.** DataChannels, `HumanInputDispatcher`, coordinate mapping,
   touch and momentum model, keyboard button and hidden textarea, control
   leases and takeover, agent cursor relay, `releaseAll` on every teardown
   path, DevTools and popup states.
4. **Resilience.** ICE restart on network change, guest crash re-arm and
   `replaceTrack`, background/foreground handling, viewer cap, stats-based
   frame rate policy.
5. **T3 Connect.** Relay Worker TURN route, broker minting, credential TTL and
   rate limit, tunnel end-to-end test.
6. **Mobile.** Singleton WebView viewer, tablet aux-pane entry.
7. **Docs.** `docs/user/remote-access.md` (using the preview from another
   device, keyboard button, take-over), `docs/internals/remote.md` (WebRTC and
   TURN in the transport model), `docs/internals/glossary.md` (viewer,
   controller, remote preview session, source generation).

Each phase is its own PR with a conventional title; phase 2 ships first as
`feat(preview): stream the desktop preview to web clients`.

## Surface checklist

- Entry points: Browser tab, mini player, command palette "Open browser"
  (unchanged, now enabled off-Electron), keybinding for toggling the right
  panel (unchanged).
- Clients: web (viewer), desktop (host + indicator), mobile (phase 6).
- Providers: none.
- Contracts: `remotePreview.ts`, `rpc.ts`, `auth.ts`, `ipc.ts`.
- Reverse states: join → leave, request control → release control, take over
  → taken over notice, paused → resumed, host gone → waiting for host.
- Connection modes: direct and Tailscale without TURN; T3 Connect with TURN;
  SSH-forwarded targets behave like direct.
- Docs: user, internals, glossary.

## Out of scope for v1

- Popup (OAuth) window capture and control.
- Audio.
- More than one controller, or more than two viewers per tab.
- Streaming when the desktop app is closed (would require an
  environment-owned Chromium).
- Remote page zoom or remote fullscreen.
- Binary-packed DataChannel messages.

## Open questions

- Should viewers see the tab while the desktop user has DevTools open, or
  should DevTools close automatically when a controller joins?
- Is a view-only pairing token worth a UI, or is the scope split enough for
  now?
- Cloudflare Realtime TURN requires an account-level TURN key on the relay
  deployment. Who owns provisioning it, and is the 1 TB/month free tier
  acceptable as the only budget guard alongside the per-session TTL?
