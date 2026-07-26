import Foundation

struct T3RecognizerCapabilities {
  let languages: [String]
  let supportsLanguageDetect: Bool
  let supportsInitialPrompt: Bool
  let supportsStreaming: Bool
}

protocol T3TranscribeRecognizing: AnyObject {
  var capabilities: T3RecognizerCapabilities { get }
  func transcribe(_ samples: [Float], language: String?, promptHint: String?) throws -> String
  func cancel()
}

enum T3ChunkedUpdate: Equatable {
  case ready(sessionId: String)
  case partial(sessionId: String, segmentId: Int, text: String)
  case final(sessionId: String, segmentId: Int, text: String)
  case ended(sessionId: String)

  var eventBody: [String: Any] {
    switch self {
    case .ready(let sessionId):
      return ["sessionId": sessionId, "kind": "ready"]
    case .partial(let sessionId, let segmentId, let text):
      return [
        "sessionId": sessionId,
        "kind": "partial",
        "segmentId": segmentId,
        "text": text,
      ]
    case .final(let sessionId, let segmentId, let text):
      return [
        "sessionId": sessionId,
        "kind": "final",
        "segmentId": segmentId,
        "text": text,
      ]
    case .ended(let sessionId):
      return ["sessionId": sessionId, "kind": "ended"]
    }
  }
}

/// Swift twin of packages/voice-core's non-streaming chunked engine.
///
/// Audio mutation stays on `stateQueue`; recognizer calls are serialized on
/// `inferenceQueue`, so the AVAudioEngine tap never blocks on model work.
final class T3ChunkedEngine {
  private struct RecognitionRequest {
    let pcm: [Float]
    let sessionId: String
    let segmentId: Int
    let generation: Int
    let isFinal: Bool
    let language: String?
    let promptHint: String?
  }

  static let silenceRMS: Float = 0.012
  static let partialInterval: TimeInterval = 1.2
  static let silenceToFinalize: TimeInterval = 0.9
  static let maxSegmentSeconds: TimeInterval = 60
  static let minimumSegmentSeconds: TimeInterval = 0.3
  static let minimumRealtimeFactor: Double = 5

  private let recognizer: T3TranscribeRecognizing
  private let stateQueue: DispatchQueue
  private let inferenceQueue: DispatchQueue
  private let onUpdate: (T3ChunkedUpdate) -> Void
  private let onError: (Error) -> Void
  private let clock: () -> TimeInterval

  private var sessionId: String?
  private var sampleRate = 16_000
  private var language: String?
  private var promptHint: String?
  private var samples: [Float] = []
  private var segmentId = 0
  private var generation = 0
  private var speechObserved = false
  private var silenceSeconds: TimeInterval = 0
  private var partialInFlight = false
  private var supersededPartialSegmentIds = Set<Int>()
  private var pendingFinals = 0
  private var stopRequested = false
  private var lastInferenceAt = -Double.infinity
  private var effectivePartialInterval = T3ChunkedEngine.partialInterval
  private var effectiveMaxSegmentSeconds = T3ChunkedEngine.maxSegmentSeconds

  init(
    recognizer: T3TranscribeRecognizing,
    label: String = UUID().uuidString,
    clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    onUpdate: @escaping (T3ChunkedUpdate) -> Void,
    onError: @escaping (Error) -> Void
  ) {
    self.recognizer = recognizer
    self.stateQueue = DispatchQueue(label: "com.t3tools.transcribe.state.\(label)")
    self.inferenceQueue = DispatchQueue(label: "com.t3tools.transcribe.inference.\(label)")
    self.clock = clock
    self.onUpdate = onUpdate
    self.onError = onError
  }

  func start(sessionId: String, sampleRate: Int, language: String?, promptHint: String?) throws {
    guard sampleRate >= 8_000 else {
      throw T3TranscribeError.invalidArgument("Sample rate must be at least 8 kHz.")
    }
    var startError: Error?
    stateQueue.sync {
      guard self.sessionId == nil else {
        startError = T3TranscribeError.sessionActive
        return
      }
      self.sessionId = sessionId
      self.sampleRate = sampleRate
      self.language = language
      self.promptHint = promptHint
      self.segmentId = 0
      self.generation += 1
      self.stopRequested = false
      self.pendingFinals = 0
      self.resetActiveSegment()
      self.onUpdate(.ready(sessionId: sessionId))
    }
    if let startError {
      throw startError
    }
  }

  func push(_ frame: [Float]) {
    guard !frame.isEmpty else { return }
    stateQueue.async { [weak self] in
      guard let self, self.sessionId != nil, !self.stopRequested else { return }
      self.samples.append(contentsOf: frame)
      let duration = Double(frame.count) / Double(self.sampleRate)
      let rms = Self.rms(frame)
      if rms >= Self.silenceRMS {
        self.speechObserved = true
        self.silenceSeconds = 0
      } else if self.speechObserved {
        self.silenceSeconds += duration
      }

      if (self.speechObserved && self.silenceSeconds >= Self.silenceToFinalize)
        || self.segmentDuration >= self.effectiveMaxSegmentSeconds {
        self.cutAndFinalize()
      } else {
        self.schedulePartialIfNeeded()
      }
    }
  }

  func stopAndCommit() {
    stateQueue.async { [weak self] in
      guard let self, self.sessionId != nil else { return }
      self.stopRequested = true
      if !self.samples.isEmpty {
        self.cutAndFinalize()
      }
      self.finishIfDrained()
    }
  }

  func cancel() {
    stateQueue.async { [weak self] in
      guard let self, let sessionId = self.sessionId else { return }
      self.generation += 1
      self.recognizer.cancel()
      self.clearSession()
      self.onUpdate(.ended(sessionId: sessionId))
    }
  }

  private var segmentDuration: TimeInterval {
    Double(samples.count) / Double(sampleRate)
  }

  private func schedulePartialIfNeeded() {
    guard
      pendingFinals == 0,
      !partialInFlight,
      segmentDuration > Self.minimumSegmentSeconds,
      let sessionId
    else {
      return
    }
    let now = clock()
    guard now - lastInferenceAt >= effectivePartialInterval else { return }
    partialInFlight = true
    lastInferenceAt = now
    let pcm = samples
    let currentSegmentId = segmentId
    let currentGeneration = generation
    let language = language
    let promptHint = promptHint
    scheduleRecognition(
      RecognitionRequest(
        pcm: pcm,
        sessionId: sessionId,
        segmentId: currentSegmentId,
        generation: currentGeneration,
        isFinal: false,
        language: language,
        promptHint: promptHint
      )
    )
  }

  private func cutAndFinalize() {
    guard !samples.isEmpty, let sessionId else { return }
    guard segmentDuration > Self.minimumSegmentSeconds else {
      resetActiveSegment()
      finishIfDrained()
      return
    }
    let pcm = samples
    let currentSegmentId = segmentId
    let currentGeneration = generation
    let language = language
    let promptHint = promptHint
    if partialInFlight {
      supersededPartialSegmentIds.insert(currentSegmentId)
    }
    segmentId += 1
    pendingFinals += 1
    resetActiveSegment()
    scheduleRecognition(
      RecognitionRequest(
        pcm: pcm,
        sessionId: sessionId,
        segmentId: currentSegmentId,
        generation: currentGeneration,
        isFinal: true,
        language: language,
        promptHint: promptHint
      )
    )
  }

  private func scheduleRecognition(_ request: RecognitionRequest) {
    inferenceQueue.async { [weak self] in
      guard let self else { return }
      let startedAt = self.clock()
      let result: Result<String, Error>
      do {
        result = .success(
          try self.recognizer.transcribe(
            request.pcm,
            language: request.language,
            promptHint: request.promptHint
          )
        )
      } catch {
        result = .failure(error)
      }
      let wallSeconds = max(0, self.clock() - startedAt)
      self.stateQueue.async { [weak self] in
        guard let self else { return }
        if !request.isFinal {
          self.partialInFlight = false
        } else {
          self.pendingFinals = max(0, self.pendingFinals - 1)
        }

        guard
          self.generation == request.generation,
          self.sessionId == request.sessionId
        else {
          return
        }
        if !request.isFinal,
          self.supersededPartialSegmentIds.remove(request.segmentId) != nil {
          self.finishIfDrained()
          return
        }
        switch result {
        case .success(let text):
          self.adaptCadence(
            audioSeconds: Double(request.pcm.count) / Double(self.sampleRate),
            wallSeconds: wallSeconds
          )
          if request.isFinal {
            self.onUpdate(
              .final(
                sessionId: request.sessionId,
                segmentId: request.segmentId,
                text: text
              )
            )
          } else if !self.stopRequested {
            self.onUpdate(
              .partial(
                sessionId: request.sessionId,
                segmentId: request.segmentId,
                text: text
              )
            )
          }
        case .failure(let error):
          self.onError(error)
        }
        self.finishIfDrained()
      }
    }
  }

  private func finishIfDrained() {
    guard stopRequested, pendingFinals == 0, let sessionId else { return }
    generation += 1
    clearSession()
    onUpdate(.ended(sessionId: sessionId))
  }

  private func adaptCadence(audioSeconds: Double, wallSeconds: Double) {
    guard audioSeconds > 0, wallSeconds > 0 else { return }
    let realtimeFactor = audioSeconds / wallSeconds
    guard realtimeFactor < Self.minimumRealtimeFactor else {
      effectivePartialInterval = Self.partialInterval
      effectiveMaxSegmentSeconds = Self.maxSegmentSeconds
      return
    }
    let ratio = max(0.25, realtimeFactor / Self.minimumRealtimeFactor)
    effectivePartialInterval = min(Self.partialInterval / ratio, 6)
    effectiveMaxSegmentSeconds = max(5, Self.maxSegmentSeconds * ratio)
  }

  private func clearSession() {
    sessionId = nil
    language = nil
    promptHint = nil
    stopRequested = false
    pendingFinals = 0
    partialInFlight = false
    supersededPartialSegmentIds.removeAll(keepingCapacity: true)
    resetActiveSegment()
  }

  private func resetActiveSegment() {
    samples.removeAll(keepingCapacity: true)
    speechObserved = false
    silenceSeconds = 0
    lastInferenceAt = -Double.infinity
  }

  static func rms(_ samples: [Float]) -> Float {
    guard !samples.isEmpty else { return 0 }
    let sum = samples.reduce(Float.zero) { $0 + ($1 * $1) }
    return sqrt(sum / Float(samples.count))
  }
}

enum T3TranscribeError: LocalizedError {
  case invalidArgument(String)
  case sessionActive
  case microphoneDenied
  case modelNotInstalled
  case capability(String)
  case nativeEngineUnavailable
  case native(String)
  case download(String)

  var errorDescription: String? {
    switch self {
    case .invalidArgument(let detail), .capability(let detail), .native(let detail),
      .download(let detail):
      return detail
    case .sessionActive:
      return "A voice capture session is already active."
    case .microphoneDenied:
      return "Microphone permission was denied."
    case .modelNotInstalled:
      return "The selected transcription model is not installed."
    case .nativeEngineUnavailable:
      return "The transcribe.cpp iOS framework is not bundled in this build."
    }
  }
}
