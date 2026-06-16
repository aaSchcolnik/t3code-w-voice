# Voice Dictation Debug Implementation Plan

Status as of 2026-06-11.

Browser-mode testing proved the Parakeet sidecar, downloaded model, server RPC path, and web audio worklet are fundamentally viable. The remaining work should focus on recording lifecycle correctness, desktop microphone permissions, voice UI, and customizable keybindings.

## Findings

1. Browser dictation works.
   - This confirms the model and sidecar are not the primary blocker.
   - The app can capture audio in browser mode and receive real-time transcription updates.

2. Desktop dictation does not work yet.
   - The packaged and dev app bundles include microphone usage descriptions, so the Info.plist key is not the missing piece.
   - The desktop app currently has no explicit Electron microphone permission flow.

3. Stop recording can leave the button stuck.
   - `MicButton` keeps the transcription subscription alive briefly after stop so trailing final events can arrive.
   - A late `ready` or transcript update can still mutate UI state after teardown unless updates are gated against the current capture.

4. Live text insertion is the wrong UX for cancel semantics.
   - The user wants Escape to stop recording and discard the transcription.
   - Writing partials directly into the composer makes discard fragile, especially if the user edits during recording.

5. Voice recording needs to be controlled through the existing keybinding system.
   - Add one configurable command: `voice.toggleRecording`.
   - Default shortcut: `alt+shift+r`.
   - Settings label: `Start/stop voice recording`.
   - The same shortcut should start and stop recording.

## Implementation Order

### 1. Fix Recording Lifecycle

Goal: stopping recording must always return the UI to the idle microphone state.

Changes:

- Gate every transcription stream update in `MicButton` or the future voice controller:
  - ignore updates if `captureRef.current !== capture`;
  - ignore updates if `capture.stopped`;
  - do not let late `ready` events set the UI back to recording.
- Consider adding a `stopping` state if needed, but the visible button should not get stuck as active after stop.
- Keep teardown idempotent.

Key files:

- `apps/web/src/components/chat/MicButton.tsx`

### 2. Introduce Voice Session State

Goal: centralize recording behavior so the mic button, keybinding, Escape handler, and overlay all use the same state machine.

Recommended shape:

- Extract capture/session logic from `MicButton` into a focused hook or controller.
- Track:
  - `idle`
  - `starting`
  - `recording`
  - `stopping`
  - `error`
- Track buffered transcript separately from composer text.
- Track waveform samples or amplitude frames from the audio worklet.

Tradeoff:

- Keeping logic inside `MicButton` is faster but will become brittle once keyboard shortcuts and overlay UI are added.
- Extracting a controller is slightly more work but avoids duplicated lifecycle logic.

Key files:

- `apps/web/src/components/chat/MicButton.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`

### 3. Split Stop Into Commit vs Cancel

Goal: normal stop commits transcript; Escape cancels and discards transcript.

Behavior:

- Normal stop:
  - stop microphone capture;
  - allow final transcript if available;
  - append committed transcript to composer once.
- Escape cancel:
  - stop microphone capture;
  - discard buffered partial/final transcript;
  - restore normal composer UI;
  - do not add transcription to the chatbox.

Important:

- Do not keep writing partials directly into composer text while recording.
- Buffer transcript in voice state and commit only on normal stop.

Key files:

- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/MicButton.tsx`

### 4. Add Voice Toggle Keybinding

Goal: users can customize the start/stop recording shortcut through the existing keybindings settings UI.

Changes:

- Add static command `voice.toggleRecording`.
- Add default keybinding:
  - `key: "alt+shift+r"`
  - `command: "voice.toggleRecording"`
  - likely `when: "!terminalFocus"`
- Add readable settings label:
  - `Start/stop voice recording`
- Wire the command in the chat/composer layer so it calls the same toggle path as the mic button.

Key files:

- `packages/contracts/src/keybindings.ts`
- `packages/shared/src/keybindings.ts`
- `apps/web/src/components/settings/KeybindingsSettings.logic.ts`
- `apps/web/src/components/chat/ChatComposer.tsx`

### 5. Add Escape Cancel

Goal: pressing Escape during recording cancels voice recording and discards transcript.

Behavior:

- If recording is active and `event.key === "Escape"`:
  - prevent default;
  - stop capture;
  - discard transcript buffer;
  - return to normal composer UI.
- This should win over composer menus while recording is active.

Key files:

- `apps/web/src/components/chat/ChatComposer.tsx`

### 6. Replace Live Text With Waveform Overlay

Goal: while recording, the composer should show a voice UI instead of real-time transcript text.

UI direction:

- Replace or overlay the composer input area with:
  - waveform bars driven by live audio amplitude;
  - mic icon / `Voice to text` label;
  - `Stop` action with shortcut hint;
  - `Cancel` action with `Esc` hint.
- Use stable dimensions so the composer does not shift while recording.

Implementation detail:

- Compute lightweight RMS/amplitude frames in the audio worklet message path.
- Keep waveform rendering client-side; do not depend on ASR partials.

Key files:

- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/MicButton.tsx`
- potential new component: `apps/web/src/components/chat/VoiceRecordingOverlay.tsx`

### 7. Add Desktop Microphone Permission Flow

Goal: desktop dictation should request and honor microphone permissions explicitly.

Changes:

- Add Electron media permission handling:
  - `session.setPermissionRequestHandler` for microphone/media capture.
- On macOS:
  - check `systemPreferences.getMediaAccessStatus("microphone")`;
  - request `systemPreferences.askForMediaAccess("microphone")` when needed.
- Surface denied/restricted permission as a clear UI error.

Important:

- Do not rely only on `navigator.mediaDevices.getUserMedia` in the renderer for desktop.
- Info.plist already contains microphone usage keys, so this is runtime permission handling.

Key files:

- `apps/desktop/src/window/DesktopWindow.ts`
- potentially preload/IPC files if permission status is exposed to web UI

### 8. Improve Server/Sidecar Diagnostics

Goal: future failures should produce concrete evidence.

Changes:

- Handle sidecar global errors without `sessionId`.
- Fail the sidecar ready deferred if startup/model load emits an error.
- Fail active sessions and shut down the sidecar on unrecoverable global errors.
- Log:
  - sidecar spawn path;
  - sidecar ready time;
  - session start/stop;
  - audio chunks received;
  - final/ended events;
  - sidecar errors.

Key files:

- `apps/server/src/transcription/TranscriptionService.ts`
- `packages/asr-sidecar/Sources/t3-asr-sidecar/main.swift`

## Verification Plan

Required before considering the task complete:

- `vp check`
- `vp run typecheck`

Manual verification:

- Browser mode:
  - press mic button;
  - see waveform overlay;
  - speak and stop normally;
  - final transcript is inserted once;
  - button returns to idle;
  - toggle shortcut starts/stops recording;
  - Escape cancels and inserts no text.
- Desktop mode:
  - microphone permission prompt/status is visible when needed;
  - allowed permission enables dictation;
  - denied permission shows a clear error;
  - same lifecycle/keybinding/cancel behavior as browser mode.
