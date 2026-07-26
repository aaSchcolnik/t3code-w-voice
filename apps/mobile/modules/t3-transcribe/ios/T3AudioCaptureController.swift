import AVFAudio
import Foundation
import UIKit

final class T3AudioCaptureController: @unchecked Sendable {
  enum Mode {
    case local
    case captureOnly
  }

  private static let targetSampleRate = 16_000
  private static let remoteChunkSamples = 4_096

  private let audioEngine = AVAudioEngine()
  private let processingQueue = DispatchQueue(
    label: "com.t3tools.transcribe.audio",
    qos: .userInitiated
  )
  private let onTranscriptionUpdate: ([String: Any]) -> Void
  private let onAudioLevel: (Float) -> Void
  private let onAudioChunk: (String) -> Void
  private let onError: (String, Error) -> Void
  private let lifecycleGuard = T3CaptureLifecycleGuard()
  private let captureReservation = T3CaptureReservation()

  private var engine: T3ChunkedEngine?
  private var recognizer: T3TranscribeRecognizing?
  private var mode: Mode?
  private var activeSessionId: String?
  private var activeReservation: T3CaptureReservation.Token?
  private var remotePending: [Float] = []
  private var lastLevelEmission = 0.0
  private var notificationObservers: [NSObjectProtocol] = []

  init(
    onTranscriptionUpdate: @escaping ([String: Any]) -> Void,
    onAudioLevel: @escaping (Float) -> Void,
    onAudioChunk: @escaping (String) -> Void,
    onError: @escaping (String, Error) -> Void
  ) {
    self.onTranscriptionUpdate = onTranscriptionUpdate
    self.onAudioLevel = onAudioLevel
    self.onAudioChunk = onAudioChunk
    self.onError = onError
    observeAudioLifecycle()
  }

  deinit {
    for observer in notificationObservers {
      NotificationCenter.default.removeObserver(observer)
    }
  }

  func start(
    sessionId: String,
    mode: Mode,
    modelURL: URL?,
    language: String?,
    promptHint: String?
  ) async throws -> T3RecognizerCapabilities? {
    let reservation = try captureReservation.reserve(sessionId: sessionId)
    do {
      guard await requestMicrophonePermission() else {
        throw T3TranscribeError.microphoneDenied
      }
      guard captureReservation.isCurrent(reservation) else {
        throw CancellationError()
      }

      let recognizer: T3TranscribeRecognizing?
      let engine: T3ChunkedEngine?
      let resolvedLanguage: String?
      switch mode {
      case .local:
        guard let modelURL else { throw T3TranscribeError.modelNotInstalled }
        let nativeRecognizer = try T3NativeRecognizer(modelURL: modelURL)
        guard captureReservation.isCurrent(reservation) else {
          throw CancellationError()
        }
        recognizer = nativeRecognizer
        resolvedLanguage = try T3LanguageResolver.resolve(
          configuredLanguage: language,
          localeIdentifier: Locale.current.identifier,
          capabilities: nativeRecognizer.capabilities
        )
        engine = T3ChunkedEngine(
          recognizer: nativeRecognizer,
          label: sessionId,
          onUpdate: { [weak self] update in
            self?.onTranscriptionUpdate(update.eventBody)
            if case .ended = update {
              self?.processingQueue.async {
                self?.clearSession(deactivateAudio: true)
              }
            }
          },
          onError: { [weak self] error in
            self?.onError(sessionId, error)
          }
        )
      case .captureOnly:
        recognizer = nil
        engine = nil
        resolvedLanguage = nil
      }

      try processingQueue.sync {
        guard captureReservation.isCurrent(reservation), activeSessionId == nil else {
          throw CancellationError()
        }
        activeSessionId = sessionId
        activeReservation = reservation
        lifecycleGuard.begin(sessionId: sessionId)
        self.mode = mode
        self.recognizer = recognizer
        self.engine = engine
        remotePending.removeAll(keepingCapacity: true)
        lastLevelEmission = 0

        do {
          try engine?.start(
            sessionId: sessionId,
            sampleRate: Self.targetSampleRate,
            language: resolvedLanguage,
            promptHint: promptHint
          )
          try configureAudioSession()
          try startAudioEngine()
        } catch {
          clearSession(deactivateAudio: true)
          throw error
        }
      }
      return recognizer?.capabilities
    } catch {
      captureReservation.clear(reservation)
      throw error
    }
  }

  func stop(commit: Bool) -> String? {
    processingQueue.sync {
      guard activeSessionId != nil else {
        captureReservation.cancelCurrent()
        return nil
      }
      stopAudioEngine()
      if mode == .captureOnly {
        let finalAudio = commit ? takeRemoteAudio() : nil
        remotePending.removeAll(keepingCapacity: true)
        clearSession(deactivateAudio: true)
        return finalAudio
      }
      if commit {
        engine?.stopAndCommit()
      } else {
        engine?.cancel()
      }
      return nil
    }
  }

  func cancel() {
    _ = stop(commit: false)
  }

  private func requestMicrophonePermission() async -> Bool {
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      return true
    case .denied:
      return false
    case .undetermined:
      return await withCheckedContinuation { continuation in
        AVAudioApplication.requestRecordPermission { granted in
          continuation.resume(returning: granted)
        }
      }
    @unknown default:
      return false
    }
  }

  private func configureAudioSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .measurement,
      options: [.allowBluetoothHFP, .defaultToSpeaker]
    )
    try session.setPreferredSampleRate(Double(Self.targetSampleRate))
    try session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true, options: .notifyOthersOnDeactivation)
  }

  private func startAudioEngine() throws {
    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.channelCount > 0, format.sampleRate >= 8_000 else {
      throw T3TranscribeError.native("No usable microphone input format is available.")
    }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 2_048, format: format) { [weak self] buffer, _ in
      guard let self, let channels = buffer.floatChannelData else { return }
      let frameCount = Int(buffer.frameLength)
      guard frameCount > 0 else { return }
      let source = Array(UnsafeBufferPointer(start: channels[0], count: frameCount))
      self.processingQueue.async {
        self.process(source, sourceRate: format.sampleRate)
      }
    }
    audioEngine.prepare()
    try audioEngine.start()
  }

  private func stopAudioEngine() {
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()
  }

  private func process(_ source: [Float], sourceRate: Double) {
    guard activeSessionId != nil else { return }
    let frame = Self.resample(source, sourceRate: sourceRate)
    guard !frame.isEmpty else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if now - lastLevelEmission >= 0.1 {
      lastLevelEmission = now
      let normalized = min(1, max(0.02, T3ChunkedEngine.rms(frame) * 14))
      onAudioLevel(normalized)
    }
    switch mode {
    case .local:
      engine?.push(frame)
    case .captureOnly:
      remotePending.append(contentsOf: frame)
      while remotePending.count >= Self.remoteChunkSamples {
        let chunk = Array(remotePending.prefix(Self.remoteChunkSamples))
        remotePending.removeFirst(Self.remoteChunkSamples)
        onAudioChunk(T3PCMCodec.int16Base64(chunk))
      }
    case nil:
      break
    }
  }

  private func takeRemoteAudio() -> String? {
    guard !remotePending.isEmpty else { return nil }
    let audio = T3PCMCodec.int16Base64(remotePending)
    remotePending.removeAll(keepingCapacity: true)
    return audio
  }

  private func clearSession(deactivateAudio: Bool) {
    if let activeSessionId {
      lifecycleGuard.clear(sessionId: activeSessionId)
    }
    if let activeReservation {
      captureReservation.clear(activeReservation)
    }
    activeSessionId = nil
    activeReservation = nil
    mode = nil
    recognizer = nil
    engine = nil
    remotePending.removeAll(keepingCapacity: true)
    if deactivateAudio {
      try? AVAudioSession.sharedInstance().setActive(
        false,
        options: .notifyOthersOnDeactivation
      )
    }
  }

  private func observeAudioLifecycle() {
    let center = NotificationCenter.default
    notificationObservers = [
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance(),
        queue: nil
      ) { [weak self] notification in
        guard
          let rawValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: rawValue) == .began
        else {
          return
        }
        self?.terminateForLifecycleEvent(.audioInterruption)
      },
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: AVAudioSession.sharedInstance(),
        queue: nil
      ) { [weak self] notification in
        guard
          let rawValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: rawValue)
        else {
          return
        }
        switch reason {
        case .oldDeviceUnavailable, .noSuitableRouteForCategory, .routeConfigurationChange:
          self?.terminateForLifecycleEvent(.inputRouteLost)
        default:
          break
        }
      },
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification,
        object: AVAudioSession.sharedInstance(),
        queue: nil
      ) { [weak self] _ in
        self?.terminateForLifecycleEvent(.mediaServicesReset)
      },
      center.addObserver(
        forName: UIApplication.didEnterBackgroundNotification,
        object: nil,
        queue: nil
      ) { [weak self] _ in
        self?.terminateForLifecycleEvent(.enteredBackground)
      },
    ]
  }

  private func terminateForLifecycleEvent(_ event: T3CaptureLifecycleEvent) {
    processingQueue.async { [weak self] in
      guard
        let self,
        let failure = self.lifecycleGuard.terminate(for: event),
        self.activeSessionId == failure.sessionId
      else {
        return
      }
      self.stopAudioEngine()
      try? AVAudioSession.sharedInstance().setActive(
        false,
        options: .notifyOthersOnDeactivation
      )
      self.onError(
        failure.sessionId,
        T3TranscribeError.native(failure.message)
      )
      if self.mode == .local {
        self.engine?.cancel()
      } else {
        self.onTranscriptionUpdate([
          "sessionId": failure.sessionId,
          "kind": "ended",
        ])
        self.clearSession(deactivateAudio: false)
      }
    }
  }

  private static func resample(_ input: [Float], sourceRate: Double) -> [Float] {
    guard sourceRate != Double(targetSampleRate) else { return input }
    let ratio = sourceRate / Double(targetSampleRate)
    let outputCount = Int(Double(input.count) / ratio)
    guard outputCount > 0 else { return [] }
    return (0..<outputCount).map { index in
      let position = Double(index) * ratio
      let lower = Int(position)
      let fraction = Float(position - Double(lower))
      let a = input[min(lower, input.count - 1)]
      let b = input[min(lower + 1, input.count - 1)]
      return a + ((b - a) * fraction)
    }
  }
}
