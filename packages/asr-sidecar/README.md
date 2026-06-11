# t3-asr-sidecar

Local speech-to-text sidecar for t3code voice dictation. Runs NVIDIA
**Parakeet TDT 0.6b v3** (multilingual, incl. Spanish + English) on the Apple
Neural Engine via [FluidAudio](https://github.com/FluidInference/FluidAudio).

The server (`apps/server/src/transcription/TranscriptionService.ts`) spawns
this binary lazily on first mic activation and talks newline-delimited JSON
over stdio (protocol documented at the top of `Sources/t3-asr-sidecar/main.swift`).
It is killed after the configured idle timeout to free model memory (~600 MB).

## Build

```sh
cd packages/asr-sidecar
swift build -c release
```

The binary lands at `.build/release/t3-asr-sidecar`. Model weights are
auto-downloaded from Hugging Face on first run
(`FluidInference/parakeet-tdt-0.6b-v3-coreml`) and cached locally.

## Wiring it up

The server resolves the binary in this order:

1. `voice.sidecarPath` in server settings (`settings.json`)
2. `T3_ASR_SIDECAR` environment variable
3. `t3-asr-sidecar` on `PATH`

Enable the feature with the `voice.enabled` server setting, e.g. by patching
settings via the API or editing the server's `settings.json`:

```json
{ "voice": { "enabled": true, "sidecarPath": "/path/to/.build/release/t3-asr-sidecar" } }
```

## Smoke test

Pipe a start + audio + stop sequence and check that partial/final events come
back (or just press the mic button in the web UI and watch this process's
stdout via the server logs).

```sh
.build/release/t3-asr-sidecar
{"type":"start","sessionId":"s1","sampleRate":16000}
{"type":"audio","sessionId":"s1","pcm":"<base64 16-bit LE mono 16 kHz PCM>"}
{"type":"stop","sessionId":"s1"}
```

## Notes

- FluidAudio's API surface moves; if `AsrModels.downloadAndLoad()` /
  `AsrManager` signatures changed since this was written, adjust
  `Engine.initialize()`/`transcribe` accordingly — the stdio protocol is the
  stable contract.
- The `language` field of `start` is currently accepted but unused: Parakeet
  TDT v3 detects language automatically across its 25 supported languages.
- Segmentation is energy-VAD based (`SILENCE_RMS`, `SILENCE_TO_FINALIZE` in
  `main.swift`); swap in FluidAudio's `VadManager` for better robustness if
  needed.
