import ExpoModulesCore
import Foundation

public final class T3TranscribeModule: Module {
  private let downloads = T3ModelDownloadManager()
  private lazy var capture = T3AudioCaptureController(
    onTranscriptionUpdate: { [weak self] update in
      self?.emit("onTranscriptionUpdate", update)
    },
    onAudioLevel: { [weak self] level in
      self?.emit("onAudioLevel", ["level": level])
    },
    onAudioChunk: { [weak self] audio in
      self?.emit("onAudioChunk", ["audio": audio])
    },
    onError: { [weak self] sessionId, error in
      self?.emit(
        "onTranscriptionError",
        [
          "sessionId": sessionId,
          "message": error.localizedDescription,
        ])
    }
  )

  public func definition() -> ModuleDefinition {
    Name("T3Transcribe")

    Constants([
      "nativeVersion": 1,
      "transcribeCppVersion": "0.1.3",
    ])

    Events(
      "onTranscriptionUpdate",
      "onTranscriptionError",
      "onAudioLevel",
      "onAudioChunk",
      "onDownloadProgress",
      "onCapabilityChanged"
    )

    OnCreate { [weak self] in
      self?.downloads.setEventSink { [weak self] event in
        self?.emit("onDownloadProgress", event)
      }
    }

    OnDestroy { [weak self] in
      self?.capture.cancel()
      self?.downloads.setEventSink(nil)
    }

    Function("getDownloadStates") { [weak self] in
      self?.downloads.states() ?? []
    }

    Function("getCapability") { (minRamMb: Int, requiresGpuFamily: String?) -> [String: Any] in
      T3DeviceCapability.inspect(
        minRamMb: minRamMb,
        requiresGpuFamily: requiresGpuFamily
      ).eventBody
    }

    AsyncFunction("downloadModel") { [weak self] (modelId: String, quantizationId: String, sourceURL: String, sha256: String, totalBytes: Int64) in
      try self?.downloads.start(
        modelId: modelId,
        quantizationId: quantizationId,
        sourceURL: sourceURL,
        sha256: sha256,
        totalBytes: totalBytes
      )
    }

    Function("pauseDownload") { [weak self] (modelId: String, quantizationId: String) in
      self?.downloads.pause(modelId: modelId, quantizationId: quantizationId)
    }

    Function("cancelDownload") { [weak self] (modelId: String, quantizationId: String) in
      self?.downloads.cancel(modelId: modelId, quantizationId: quantizationId)
    }

    Function("removeModel") { [weak self] (modelId: String, quantizationId: String) in
      self?.downloads.remove(modelId: modelId, quantizationId: quantizationId)
    }

    AsyncFunction("startCapture") { [weak self] (sessionId: String, captureMode: String, modelId: String?, quantizationId: String?, minRamMb: Int, requiresGpuFamily: String?, language: String?, promptHint: String?) -> [String: Any]? in
      guard let self else { return nil }
      let mode: T3AudioCaptureController.Mode
      let modelURL: URL?
      if captureMode == "local" {
        mode = .local
        let capability = T3DeviceCapability.inspect(
          minRamMb: minRamMb,
          requiresGpuFamily: requiresGpuFamily
        )
        guard capability.allowed else {
          throw T3TranscribeError.capability(
            capability.reason ?? "This device cannot safely load the selected model."
          )
        }
        guard let modelId, let quantizationId else {
          throw T3TranscribeError.invalidArgument("A local model selection is required.")
        }
        modelURL = self.downloads.modelURL(
          modelId: modelId,
          quantizationId: quantizationId
        )
      } else if captureMode == "captureOnly" {
        mode = .captureOnly
        modelURL = nil
      } else {
        throw T3TranscribeError.invalidArgument("Unknown capture mode \(captureMode).")
      }

      let capabilities = try await self.capture.start(
        sessionId: sessionId,
        mode: mode,
        modelURL: modelURL,
        language: language,
        promptHint: promptHint
      )
      guard let capabilities else { return nil }
      return [
        "languages": capabilities.languages,
        "supportsLanguageDetect": capabilities.supportsLanguageDetect,
        "supportsInitialPrompt": capabilities.supportsInitialPrompt,
        "supportsStreaming": capabilities.supportsStreaming,
      ]
    }

    Function("stopCapture") { [weak self] (commit: Bool) -> String? in
      self?.capture.stop(commit: commit)
    }

    Function("cancelCapture") { [weak self] in
      self?.capture.cancel()
    }
  }

  private func emit(_ event: String, _ body: [String: Any]) {
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(event, body)
    }
  }
}
