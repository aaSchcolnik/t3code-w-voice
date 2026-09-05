# Remote preview debugging status

Date: 2026-09-04

This is a working handoff note, not durable architecture. The durable facts now live in
[remote.md](./remote.md) under "Remote preview streaming". Do not commit this file.

## Symptom

A preview tab opened on the desktop host synchronized to a remote Safari client (desktop Safari and
iPad Safari over Tailscale), but the remote surface stayed on `Connecting…` and never received a
video frame. An earlier session spent about ninety minutes on this with computer use and left the
cause open.

## Root causes found by reading the signaling path

Two independent defects sat between the host's offer and a working peer connection. Either one alone
keeps the viewer on `Connecting…`; the second also means the earlier session could not have succeeded
even if the first had been absent.

### 1. Stream atoms drop every event but the last in a chunk

Both remote-preview subscriptions (`remotePreview.open` on the viewer and `remotePreview.hostConnect`
on the host) were consumed through `createEnvironmentRpcSubscriptionAtomFamily`. A stream-backed
atom in `effect/unstable/reactivity` sets its value to `Arr.lastNonEmpty(chunk)` for each chunk it
pulls, so any signaling events that arrive in one chunk collapse to the newest one.

The host sends its offer and immediately follows it with `sourceMetadata`. When the two land in the
same chunk on the viewer, the offer is gone: `setRemoteDescription` never runs, `ontrack` never fires,
and the status never leaves `connecting`. ICE candidates, which arrive in bursts, were exposed to the
same loss on both sides.

Fix: both families now pass `transform: Stream.chunks`, so the atom value is the whole chunk, and
both consumers replay every event in order. Covered by
`apps/web/src/browser/remotePreviewStreamConsumer.test.ts`.

### 2. Guest source-metadata generations leaked into the signaling generation

`RemotePreviewSourceMetadata.generation` is the desktop's own counter for the guest surface and
starts at 1 on the first read. The broker's `hostSignal` treated it as the session's signaling
generation and advanced the session to it, and the viewer's `observeSignalingGeneration` did the same.
The host peer, however, keeps the generation from the `start` request (0).

Sequence: host sends offer (gen 0), then metadata (gen N ≥ 1); broker session becomes N; viewer
answers with N; host drops the answer because N ≠ 0; every host ICE candidate (gen 0) is dropped by
the broker as stale. No connection can ever complete.

Fix: the broker forwards `sourceMetadata` without gating or advancing the session generation, and the
viewer only updates its source generation from it. Covered by new cases in
`RemotePreviewSessionBroker.test.ts` and `remotePreviewViewer.test.ts`; both fail against the
previous code.

## Failures now surface instead of hanging

- The host renderer logs `[remote-preview] host start requested / source ready / capture acquired /
offer sent`. A stalled start names the last step that completed.
- When `resolveRuntimeTabId` or `RemotePreviewPeer.create` throws, the host logs
  `[remote-preview] host could not start streaming` with the cause and signals the new
  `capture-failed` host state. The viewer shows "The desktop app could not stream this tab" rather
  than `Connecting…`.

## Earlier fixes kept from the previous session

- Electron `display-capture` permission allowed in `DesktopWindow.ts`.
- Bounded retry while a newly created webview registers, in `remotePreviewPeer.ts`.
- Initial encoding declared through `addTransceiver`, H.264 preferred without dropping fallbacks.

## Still unverified

These fixes were proven with focused unit tests, per-package typecheck, and lint. They have not yet
been exercised end to end against a packaged desktop build and a Safari viewer. If `Connecting…`
persists after this change, the renderer milestone log and the `capture-failed` message identify the
failing step directly; the previous macOS Screen Recording and ad-hoc signing notes still apply to
packaged builds.
