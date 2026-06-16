# Voice Transcription — Remaining Work

Status as of 2026-06-11. The full pipeline (contracts → server `TranscriptionService` → Swift sidecar → web MicButton/composer insertion) is implemented, typechecks, and passes tests. What's left maps to phases 4–5 of the v2 architecture doc, plus a settings UI gap.

---

## 1. Latency & quality validation (Phase 5 — Hardening)

Nothing has run end-to-end against the real model yet. The sidecar builds, but the model (~600 MB, `FluidInference/parakeet-tdt-0.6b-v3-coreml`) downloads on first use, and no real audio has flowed through.

**To validate (acceptance criteria from the doc):**

- [ ] Cold start: first mic press → first partial in **≤ 5 s** (includes model load).
- [ ] Warm: subsequent utterances → first partial in **≤ ~1.5 s**.
- [ ] Spanish _and_ English quality noticeably better than iOS dictation.
- [ ] Memory: no sidecar process when voice is unused; RSS released after `idleTimeoutMinutes` (verify via the existing process diagnostics panel).
- [ ] Long-session behavior: 5+ minute dictation, multi-segment, no buffer growth (segment hard cap is 60 s in `main.swift`).

**Tuning knobs that will likely need adjustment with real audio** (all in `packages/asr-sidecar/Sources/t3-asr-sidecar/main.swift`):

- `PARTIAL_INTERVAL` (1.2 s) — partial cadence vs. ANE load.
- `SILENCE_RMS` (0.012) — energy-VAD threshold; browser AGC levels vary, this is a guess.
- `SILENCE_TO_FINALIZE` (0.9 s) — pause length that commits a segment.
- Consider swapping the energy VAD for FluidAudio's `VadManager` if false finalizations are common.

**Also missing:** latency logging/instrumentation (timestamp at chunk send → partial receipt) to actually measure the above instead of eyeballing it.

---

## 2. Settings UI

The `voice` settings exist in the schema (`packages/contracts/src/settings.ts`: `enabled`, `language`, `sidecarPath`, `idleTimeoutMinutes`) and round-trip through `server.updateSettings`, but **there is no UI to edit them**. Today they're only settable by editing the server's `settings.json` by hand or calling the RPC.

**To build:**

- [ ] A "Voice" section in the web settings panel (`apps/web` settings UI) with:
  - toggle for `enabled`
  - language hint select (empty = auto; Parakeet v3 supports 25 languages, `es`/`en` are the ones we care about)
  - sidecar binary path input (with a "not found" validation state would be nice)
  - idle timeout number input (minutes, min 1)
- [ ] Surface a sensible error in that UI when the mic button reports `TranscriptionSidecarError(spawnFailed/notFound)` — right now it's only a toast at mic-press time.
- [ ] Optional: provider-settings-style annotations exist in the schema layer (`Schema.annotateKey({ title, description, providerSettingsForm })`) — adding them to `VoiceSettings` would let any schema-driven form render it with less custom code.

---

## 3. Remote serving — iPhone Safari over Tailscale (Phase 4)

Architecturally this should be "free" (audio rides the existing authenticated client↔server WS; the relay never carries audio), but it is **unverified** and has known platform constraints:

- [ ] **HTTPS requirement:** `getUserMedia` in iOS Safari requires a secure context. Over plain Tailscale IP/port it will be blocked. Set up `tailscale serve` so the t3code server gets a valid cert, and verify the mic permission prompt appears.
- [ ] **Verify T3 Connect / relay-linked access path:** if the phone connects via the relay-issued link, confirm that path is already HTTPS end-to-end (the doc says "should be — verify").
- [ ] **Background-tab suspension:** iOS Safari suspends inactive tabs — dictation only works with the screen on and the tab foregrounded. Confirm the MicButton's teardown handles a suspension mid-utterance gracefully (the WS will drop; `teardownCapture` should fire, no orphan session server-side — the server's idle reaper is the backstop).
- [ ] **Bandwidth check:** raw 16 kHz PCM16 is ~256 kbps upstream. Fine on Tailscale/LAN; if remote-over-cellular matters later, switch capture to Opus via `MediaRecorder` (~24 kbps) and add a decode step in the sidecar or server.
- [ ] **Reconnect mid-utterance:** the WS client auto-resubscribes streams on reconnect, but the transcription session is dead server-side after a drop. Verify the UX degrades cleanly (button returns to idle, toast) rather than appearing stuck.

---

## Quick-start reminder

```sh
cd packages/asr-sidecar && swift build -c release
# then in the server's settings.json:
# {"voice": {"enabled": true, "sidecarPath": "<repo>/packages/asr-sidecar/.build/release/t3-asr-sidecar"}}
```

First mic press downloads the model (one-time, ~600 MB) — expect a long "starting" state that one time.
