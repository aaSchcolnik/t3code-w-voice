# Voice V2 Audit Findings

> These findings describe the audited snapshot. Some remediation had started, but it was not fully integrated or reverified.

## Confirmed or high-confidence issues

- **[P0] Packaged macOS microphone permission was incomplete**
  - **Found in:** `scripts/build-desktop-artifact.ts:802-828, 1683-1706`
  - **Problem:** The packaged app lacked `NSMicrophoneUsageDescription`; signed builds also replaced the static entitlements with generated entitlements missing `com.apple.security.device.audio-input`.
  - **Possible fix:** Add the usage description to `extendInfo`, include audio-input in generated main/helper entitlements, and inspect the final signed bundle. A preliminary fix was applied but not fully reverified.

- **[P1] Audio can be overtaken by Stop**
  - **Found in:** `apps/web/src/voice/transports/remoteTransport.ts:120-141`, `apps/web/src/voice/transports/desktopTransport.ts:70+`
  - **Problem:** Audio sends are independent asynchronous operations, so Stop can reach the server or desktop engine before queued audio.
  - **Possible fix:** Use a per-session serialized promise queue with bounded backpressure; Stop must await all accepted audio.

- **[P1] Final transcription can be truncated by watchdog timers**
  - **Found in:** `apps/web/src/components/chat/useVoiceDictationSession.ts:140-167`, `apps/mobile/src/features/voice/useVoiceDictation.ts:338-373`
  - **Problem:** Web commits after 800 ms; mobile after 1.2 or 15 seconds. Slow final inference can be cancelled before emitting `ended`.
  - **Possible fix:** Treat `ended` as authoritative. Use a substantially longer watchdog that reports a timeout instead of silently committing incomplete text.

- **[P1] Web microphone capture can start after cancellation or unmount**
  - **Found in:** `apps/web/src/components/chat/useVoiceDictationSession.ts:182-285`
  - **Problem:** The active capture is registered only after permission and capability awaits. Cancellation during startup does nothing, and capture can later continue.
  - **Possible fix:** Create a startup generation/abort token before the first await and check it after every asynchronous boundary.

- **[P1] Mobile has the same delayed-start lifecycle problem**
  - **Found in:** `apps/mobile/modules/t3-transcribe/ios/T3AudioCaptureController.swift:42-109, 126-128`
  - **Problem:** Native session state is assigned after permission/model loading, so Stop can miss a pending session that later starts `AVAudioEngine`.
  - **Possible fix:** Reserve a pending session token immediately, serialize controller state, and recheck cancellation before starting audio.

- **[P1] Swift cancellation can abort the wrong segment**
  - **Found in:** `apps/mobile/modules/t3-transcribe/ios/T3ChunkedEngine.swift:180-253`, `apps/mobile/modules/t3-transcribe/ios/T3NativeRecognizer.swift:169-174`
  - **Problem:** Cancelling a queued partial can cancel a previous segment’s currently running final inference.
  - **Possible fix:** Do not queue partials while finals are pending, coalesce partial requests, and make cancellation request-specific.

- **[P1] Server transcription sessions are not bound to their connection**
  - **Found in:** `apps/server/src/ws.ts:1919-1934`, `apps/server/src/transcription/TranscriptionService.ts:129, 388`
  - **Problem:** Another authorized client that learns a session ID could inject audio or stop it.
  - **Possible fix:** Key sessions by authenticated connection owner plus client session ID and add cross-client authorization tests.

- **[P1] Transcription reconnect can silently restart an existing session**
  - **Found in:** `packages/client-runtime/src/state/transcription.ts:19+`, `packages/client-runtime/src/rpc/client.ts:173-183`
  - **Problem:** A reconnect may invoke `transcription.start` again with the same ID and reset segment numbering.
  - **Possible fix:** Make transcription subscriptions connection-ephemeral and terminate capture on disconnect, unless a genuine resumable protocol is implemented.

- **[P1] Server downloads can exceed the catalog’s declared size**
  - **Found in:** `packages/voice-core/src/download/core.ts:133-146`
  - **Problem:** Response chunks are appended without rejecting an oversized body or invalid range response.
  - **Possible fix:** Reject before an append exceeds expected bytes; validate `Content-Length`/`Content-Range` and require catalog hashes.

- **[P1] Mobile default Parakeet may receive no language**
  - **Found in:** `apps/mobile/src/features/voice/useVoiceDictation.ts:230-240`
  - **Problem:** Parakeet does not support automatic language detection, but an empty server language becomes `nil`.
  - **Possible fix:** Resolve language from configured settings and device locale; warn or fall back to server when unsupported.

- **[P1] Desktop renderer crashes can orphan transcription**
  - **Found in:** `apps/desktop/src/transcription/DesktopTranscriptionService.ts:117-137, 275-280`, desktop IPC handlers
  - **Problem:** Sessions are not associated with the originating `webContents`, so reload/crash can leave the utility process permanently active.
  - **Possible fix:** Bind sessions to their renderer, cancel on `destroyed`/`render-process-gone`, and add an inactivity watchdog.

- **[P1] Windows ARM64 packaging references a nonexistent package**
  - **Found in:** `scripts/build-desktop-artifact.ts:108-112, 880-883, 1010-1026`
  - **Problem:** It expects `@transcribe-cpp/win32-arm64-cpu-vulkan`, which upstream does not publish.
  - **Possible fix:** Disable Windows ARM64 voice packaging until upstream ships it, or provide/build the missing artifact.

## Medium-priority correctness issues

- **Settings changes can cancel active web recording**
  - **Found in:** `apps/web/src/components/chat/useVoiceDictationSession.ts:112-180`
  - **Problem:** Dictionary changes recreate callbacks, causing React effect cleanup to cancel capture.
  - **Possible fix:** Store the latest dictionary in a ref and keep finalization/cleanup callbacks stable.

- **Desktop concurrent starts can corrupt session tracking**
  - **Found in:** `apps/desktop/src/transcription/DesktopTranscriptionService.ts:117-134`
  - **Problem:** Two starts can pass the active-session check before either reserves the session.
  - **Possible fix:** Reserve synchronously before awaiting model resolution or serialize starts with a lock.

- **Installed models may be trusted by size alone**
  - **Found in:** `apps/server/src/transcription/ServerVoiceModelManager.ts:397, 456`, `apps/desktop/src/transcription/DesktopModelManager.ts:154-171, 269-275`, `apps/mobile/modules/t3-transcribe/ios/T3ModelDownloadManager.swift:76-125`
  - **Problem:** Same-size corruption or tampering can reach native model parsing.
  - **Possible fix:** Persist verified SHA-256 plus file identity/mtime and rehash whenever the file changes.

- **Sideloaded models can follow symlinks outside the model directory**
  - **Found in:** `apps/server/src/transcription/ServerVoiceModelManager.ts:365, 555`, `apps/server/src/transcription/TranscribeCppEngine.ts:156`
  - **Problem:** Basename checks do not stop `stat()` from following symlinks.
  - **Possible fix:** Use `lstat`, reject symbolic links, and validate realpath containment immediately before loading.

- **Server model selection has concurrency races**
  - **Found in:** `apps/server/src/transcription/ServerVoiceModelManager.ts:230-359`
  - **Problem:** Snapshot fallback selection can overwrite a concurrent explicit user selection.
  - **Possible fix:** Serialize all selection mutations under a mutex or revision-based compare-and-set.

- **Downloading an already-installed server model is not idempotent**
  - **Found in:** `apps/server/src/transcription/ServerVoiceModelManager.ts:254+`
  - **Problem:** Repeated Download can consume bandwidth and rewrite an active model.
  - **Possible fix:** Return the current snapshot when an installed model is already verified.

- **Mobile can commit a partial transcript after remote Stop fails**
  - **Found in:** `apps/mobile/src/features/voice/useVoiceDictation.ts:359-373`
  - **Problem:** The Stop result is ignored, and the timer later commits available partial text.
  - **Possible fix:** Inspect the RPC result, surface failure, and avoid committing or retry Stop.

- **Removing the selected mobile model leaves stale preferences**
  - **Found in:** `apps/mobile/src/features/settings/SettingsVoiceRouteScreen.tsx:103-116`
  - **Problem:** Local mode and model IDs remain selected after the file is removed.
  - **Possible fix:** Switch to server mode and clear the selected IDs as part of confirmed removal.

- **Mobile disk-full failures are not consistently recoverable**
  - **Found in:** `apps/mobile/modules/t3-transcribe/ios/T3ModelDownloadManager.swift:98-142, 306-335`
  - **Problem:** Preflight and runtime disk failures can leave no useful error state or retain partial data.
  - **Possible fix:** Normalize them to `disk_full`, clean partial/resume data, and expose retry after space is freed.

- **Mobile audio interruptions and route changes are unhandled**
  - **Found in:** `apps/mobile/modules/t3-transcribe/ios/T3AudioCaptureController.swift:147-182`
  - **Problem:** Calls, Siri, route changes, media-service resets, or backgrounding can leave UI showing a dead recording.
  - **Possible fix:** Observe `AVAudioSession` and application lifecycle events and emit a session-scoped terminal error or controlled restart.

- **Automatic mode assumes enabled server transcription is reachable**
  - **Found in:** `apps/web/src/voice/transcriberFactory.ts:87-96, 138-143`
  - **Problem:** A broken server is selected even when a working local model exists.
  - **Possible fix:** Add a health/reachability signal or retry locally when server start fails.

## Alias, dictionary, and catalog issues

- **Unicode fallback matching can apply wrong offsets**
  - **Found in:** `packages/voice-core/src/aliases/boundary.ts:101-106`
  - **Problem:** Lowercasing can change UTF-16 length, such as Turkish `İ`, making transformed offsets unsafe.
  - **Possible fix:** Compare folded code-point slices while retaining original-string offsets.

- **Alias idempotence protection suppresses valid aliases**
  - **Found in:** `packages/voice-core/src/aliases/engine.ts:106-147`
  - **Problem:** With `foo → bar` and `bar → baz`, original `bar` may be protected and never replaced.
  - **Possible fix:** Define chain/cycle semantics and track replacement provenance instead of protecting every raw replacement occurrence.

- **Prompt-biased terms are still fuzzy-corrected**
  - **Found in:** `packages/voice-core/src/aliases/engine.ts:200-209`, web/mobile prompt builders
  - **Problem:** Terms already supplied as model prompts are not excluded from fuzzy replacement.
  - **Possible fix:** Pass prompted terms into alias options and skip their fuzzy rules.

- **Dictionary contracts allow excessive or invalid data**
  - **Found in:** `packages/contracts/src/settings.ts:407-431, 617`
  - **Problem:** Empty originals, aliases without replacements, duplicate IDs, and unbounded strings/arrays can decode.
  - **Possible fix:** Add bounded trimmed schemas and server-side validation for conditional fields and unique IDs.

- **Chunked inference lacks the sidecar’s minimum segment duration**
  - **Found in:** `packages/voice-core/src/chunkedEngine.ts:113-117, 211`
  - **Problem:** Very short audio can trigger inference immediately.
  - **Possible fix:** Add the sidecar’s approximately 300 ms minimum and cover it in shared conformance tests.

- **Catalog generation stops at 100 repositories**
  - **Found in:** `packages/voice-core/scripts/generate-catalog.ts:146-153`
  - **Problem:** A hard-coded API limit can silently omit future models.
  - **Possible fix:** Paginate until exhaustion and test discovered count and uniqueness.

## UI and onboarding issues

- **Electron settings hide the remote server model manager**
  - **Found in:** `apps/web/src/components/settings/VoiceSettingsPanel.tsx:253-337`
  - **Problem:** Presence of the local desktop bridge disables server model management even when server inference is selected.
  - **Possible fix:** Present separate Local and Server model registries based on inference destination.

- **First-run consent repeats while a download is in progress**
  - **Found in:** `apps/web/src/components/chat/useVoiceDictationSession.ts:340-379`
  - **Problem:** Only `done` is recognized; queued/downloading/paused/error states can reopen onboarding.
  - **Possible fix:** Persist the consent decision, handle every download state, and show composer-level progress/retry controls.

- **Dictionary version-skew detection can produce false failures**
  - **Found in:** `apps/web/src/components/settings/VoiceSettingsPanel.tsx:323+`
  - **Problem:** A fixed two-second comparison can interpret latency or rapid edits as an old server.
  - **Possible fix:** Use explicit capability/revision acknowledgements and cancel obsolete probes.

- **“Expected speed” is based only on model size**
  - **Found in:** `apps/web/src/components/settings/VoiceSettingsPanel.logic.ts:48-54`
  - **Problem:** It is not device-specific as described by the plan.
  - **Possible fix:** Add persisted calibration/RTF data or relabel it as model size/complexity.

## Remaining verification and release gaps

- The complete iOS application had not been generated, built, launched, and exercised in the Simulator.
- The Swift package tests exclude several important production files, including native recognition, downloading, capability gating, and Expo-module integration.
- Swift and TypeScript conformance fixtures are duplicated rather than consumed from one shared resource.
- The vendored iOS ABI wrapper does not fully validate native struct size/alignment at runtime.
- Packaged transcription of a checked-in WAV was not implemented or exercised.
- The signed/notarized macOS bundle, final microphone metadata, entitlements, native architectures, and runtime library loading were not fully verified.
- A12/A13 and A15 performance, thermal, memory/jetsam, interruption, background-download, network-flap, and iCloud-backup behavior require physical-device testing.
- `apps/mobile/modules/t3-transcribe/.build/` was reported as a large unignored SwiftPM build directory and should be ignored and removed from deliverable scope.
