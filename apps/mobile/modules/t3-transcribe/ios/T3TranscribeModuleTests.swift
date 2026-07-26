import XCTest

#if canImport(T3TranscribeNative)
  @testable import T3TranscribeNative
#elseif canImport(T3ChunkedEngineCore)
  @testable import T3ChunkedEngineCore
#endif

private final class FixtureRecognizer: T3TranscribeRecognizing {
  let capabilities = T3RecognizerCapabilities(
    languages: ["en"],
    supportsLanguageDetect: true,
    supportsInitialPrompt: false,
    supportsStreaming: false
  )

  func transcribe(
    _: [Float],
    language _: String?,
    promptHint _: String?
  ) throws -> String {
    "fixture"
  }

  func cancel() {}
}

private final class BlockingRecognizer: T3TranscribeRecognizing {
  let capabilities = T3RecognizerCapabilities(
    languages: ["en"],
    supportsLanguageDetect: true,
    supportsInitialPrompt: false,
    supportsStreaming: false
  )
  let started = DispatchSemaphore(value: 0)
  private let release = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var calls = 0
  private(set) var cancellationCount = 0

  func transcribe(
    _: [Float],
    language _: String?,
    promptHint _: String?
  ) throws -> String {
    lock.lock()
    calls += 1
    let call = calls
    lock.unlock()
    if call == 1 {
      started.signal()
      release.wait()
    }
    return call == 1 ? "superseded partial" : "final fixture"
  }

  func cancel() {
    lock.lock()
    cancellationCount += 1
    lock.unlock()
  }

  func releaseFirstCall() {
    release.signal()
  }
}

private struct ChunkedConformanceVector: Decodable {
  struct Frame: Decodable {
    let sample: Float
    let sampleCount: Int
  }

  let name: String
  let sampleRate: Int
  let frames: [Frame]
  let expected: [String]
}

private func sharedChunkedConformanceVectors() throws -> [ChunkedConformanceVector] {
  let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
  let fixture = repositoryRoot
    .appendingPathComponent("packages/voice-core/test/conformance/chunked-vectors.json")
  return try JSONDecoder().decode(
    [ChunkedConformanceVector].self,
    from: Data(contentsOf: fixture)
  )
}

final class T3TranscribeModuleTests: XCTestCase {
  /// Replays the same checked-in vectors as packages/voice-core.
  func testChunkedEngineMatchesSharedGoldenVector() throws {
    let vector = try XCTUnwrap(sharedChunkedConformanceVectors().first)
    let completed = expectation(description: "golden updates")
    var updates: [T3ChunkedUpdate] = []
    let lock = NSLock()
    let engine = T3ChunkedEngine(
      recognizer: FixtureRecognizer(),
      clock: { 0 },
      onUpdate: { update in
        lock.lock()
        updates.append(update)
        let count = updates.count
        lock.unlock()
        if count == vector.expected.count {
          completed.fulfill()
        }
      },
      onError: { error in
        XCTFail("Unexpected recognizer error: \(error)")
      }
    )

    try engine.start(
      sessionId: vector.name,
      sampleRate: vector.sampleRate,
      language: nil,
      promptHint: nil
    )
    for frame in vector.frames {
      engine.push(Array(repeating: frame.sample, count: frame.sampleCount))
    }
    engine.stopAndCommit()

    wait(for: [completed], timeout: 2)
    lock.lock()
    let kinds = updates.map { update -> String in
      switch update {
      case .ready: "ready"
      case .partial: "partial"
      case .final: "final"
      case .ended: "ended"
      }
    }
    lock.unlock()
    XCTAssertEqual(kinds, vector.expected)
  }

  func testCaptureOnlyPCMEncodingUsesLittleEndianInt16() {
    let bytes = [UInt8](T3PCMCodec.int16Data([-1, 0, 1]))
    XCTAssertEqual(bytes, [0x01, 0x80, 0x00, 0x00, 0xff, 0x7f])
  }

  func testFinalizationSupersedesAnInFlightPartialWithoutCancellingRecognizer() throws {
    let recognizer = BlockingRecognizer()
    let completed = expectation(description: "final after cancelled partial")
    var kinds: [String] = []
    let lock = NSLock()
    let engine = T3ChunkedEngine(
      recognizer: recognizer,
      onUpdate: { update in
        lock.lock()
        switch update {
        case .ready: kinds.append("ready")
        case .partial: kinds.append("partial")
        case .final: kinds.append("final")
        case .ended:
          kinds.append("ended")
          completed.fulfill()
        }
        lock.unlock()
      },
      onError: { error in
        XCTFail("Superseded partial leaked an error: \(error)")
      }
    )

    try engine.start(sessionId: "cancel-partial", sampleRate: 8_000, language: nil, promptHint: nil)
    engine.push(Array(repeating: 0.02, count: 3_200))
    XCTAssertEqual(recognizer.started.wait(timeout: .now() + 2), .success)
    engine.push(Array(repeating: 0, count: 7_200))
    engine.stopAndCommit()
    XCTAssertEqual(recognizer.cancellationCount, 0)
    recognizer.releaseFirstCall()

    wait(for: [completed], timeout: 2)
    lock.lock()
    let result = kinds
    lock.unlock()
    XCTAssertEqual(result, ["ready", "final", "ended"])
  }

  func testCaptureReservationRejectsLateCompletionAfterCancellation() throws {
    let reservations = T3CaptureReservation()
    let cancelled = try reservations.reserve(sessionId: "same-session-id")
    XCTAssertTrue(reservations.isCurrent(cancelled))
    XCTAssertEqual(reservations.cancelCurrent(), cancelled)
    XCTAssertFalse(reservations.isCurrent(cancelled))

    let replacement = try reservations.reserve(sessionId: "same-session-id")
    XCTAssertTrue(reservations.isCurrent(replacement))
    XCTAssertFalse(reservations.isCurrent(cancelled))
  }

  func testLanguageResolverUsesConfiguredOrDeviceLanguageForNonDetectingModels() throws {
    let capabilities = T3RecognizerCapabilities(
      languages: ["en", "es"],
      supportsLanguageDetect: false,
      supportsInitialPrompt: false,
      supportsStreaming: false
    )

    XCTAssertEqual(
      try T3LanguageResolver.resolve(
        configuredLanguage: "ES-MX",
        localeIdentifier: "en-US",
        capabilities: capabilities
      ),
      "es"
    )
    XCTAssertEqual(
      try T3LanguageResolver.resolve(
        configuredLanguage: nil,
        localeIdentifier: "es-MX",
        capabilities: capabilities
      ),
      "es"
    )
    XCTAssertThrowsError(
      try T3LanguageResolver.resolve(
        configuredLanguage: nil,
        localeIdentifier: "ja-JP",
        capabilities: capabilities
      )
    )
  }

  func testModelIntegrityRejectsSameSizeTampering() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: directory) }
    let model = directory.appendingPathComponent("fixture.gguf")
    try Data("good".utf8).write(to: model, options: .atomic)
    let expectedSHA256 = try T3ModelFileIntegrity.sha256(of: model)

    let verified = try T3ModelFileIntegrity.verify(
      model,
      expectedSize: 4,
      expectedSHA256: expectedSHA256
    )
    XCTAssertEqual(verified, try T3ModelFileIntegrity.identity(of: model))

    try Data("evil".utf8).write(to: model, options: .atomic)
    XCTAssertNotEqual(verified, try T3ModelFileIntegrity.identity(of: model))
    XCTAssertThrowsError(
      try T3ModelFileIntegrity.verify(
        model,
        expectedSize: 4,
        expectedSHA256: expectedSHA256
      )
    )
  }

  func testNativeABI013LayoutsAreCheckedBeforeUse() throws {
    let layouts = Dictionary(
      uniqueKeysWithValues: T3NativeABI.version013Layouts.map {
        ($0.id, ($0.size, $0.alignment))
      }
    )
    XCTAssertNoThrow(
      try T3NativeABI.validate(
        size: { layouts[$0, default: (0, 0)].0 },
        alignment: { layouts[$0, default: (0, 0)].1 }
      )
    )
    XCTAssertThrowsError(
      try T3NativeABI.validate(
        size: { $0 == 2 ? 72 : layouts[$0, default: (0, 0)].0 },
        alignment: { layouts[$0, default: (0, 0)].1 }
      )
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("transcribe_run_params"))
    }
  }

  func testNativeABIRejectsAnUnexpectedInitializedStructSize() {
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: 16, alignment: 8)
    defer { buffer.deallocate() }
    buffer.storeBytes(of: UInt64(24), as: UInt64.self)

    XCTAssertThrowsError(
      try T3NativeABI.validateInitializedStruct(
        UnsafeRawPointer(buffer),
        name: "fixture",
        expectedSize: 16
      )
    )
  }

  func testLifecycleFailureIsSessionScopedAndTerminal() {
    let lifecycle = T3CaptureLifecycleGuard()
    lifecycle.begin(sessionId: "session-one")

    XCTAssertEqual(
      lifecycle.terminate(for: .audioInterruption),
      T3CaptureTerminalFailure(
        sessionId: "session-one",
        message: "Voice capture ended because the audio session was interrupted."
      )
    )
    XCTAssertNil(lifecycle.terminate(for: .mediaServicesReset))

    lifecycle.clear(sessionId: "session-one")
    lifecycle.begin(sessionId: "session-two")
    XCTAssertEqual(
      lifecycle.terminate(for: .enteredBackground)?.sessionId,
      "session-two"
    )
  }
}
