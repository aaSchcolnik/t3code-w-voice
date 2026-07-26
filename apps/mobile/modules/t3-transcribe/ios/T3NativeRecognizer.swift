import Darwin
import Foundation
import os.lock

private let t3AbortCallback: @convention(c) (UnsafeMutableRawPointer?) -> Bool = { context in
  guard let context else { return false }
  return Unmanaged<T3AbortState>.fromOpaque(context).takeUnretainedValue().isAborted
}

private final class T3AbortState {
  private var lock = os_unfair_lock_s()
  private var aborted = false

  var isAborted: Bool {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    return aborted
  }

  func abort() {
    os_unfair_lock_lock(&lock)
    aborted = true
    os_unfair_lock_unlock(&lock)
  }
}

/// Thin, version-gated C ABI host for the transcribe.cpp 0.1.3 framework.
///
/// The ABI is the same public surface consumed by the pinned Node binding. We
/// resolve it dynamically so capture-only builds remain valid when the iOS
/// framework is intentionally omitted; local capability then reports false.
final class T3NativeRecognizer: T3TranscribeRecognizing {
  private typealias VoidFn = @convention(c) () -> Void
  private typealias StatusFn = @convention(c) () -> Int32
  private typealias VersionFn = @convention(c) () -> UnsafePointer<CChar>?
  private typealias StatusStringFn = @convention(c) (Int32) -> UnsafePointer<CChar>?
  private typealias InitStructFn = @convention(c) (UnsafeMutableRawPointer?) -> Void
  private typealias ModelLoadFn =
    @convention(c) (
      UnsafePointer<CChar>?,
      UnsafeRawPointer?,
      UnsafeMutablePointer<UnsafeMutableRawPointer?>?
    ) -> Int32
  private typealias ModelFreeFn = @convention(c) (UnsafeMutableRawPointer?) -> Void
  private typealias ModelCapabilitiesFn =
    @convention(c) (
      UnsafeMutableRawPointer?,
      UnsafeMutableRawPointer?
    ) -> Int32
  private typealias ModelSupportsFn = @convention(c) (UnsafeMutableRawPointer?, Int32) -> Bool
  private typealias ModelAcceptsExtensionFn =
    @convention(c) (
      UnsafeMutableRawPointer?,
      Int32,
      UInt32
    ) -> Bool
  private typealias SessionInitFn =
    @convention(c) (
      UnsafeMutableRawPointer?,
      UnsafeRawPointer?,
      UnsafeMutablePointer<UnsafeMutableRawPointer?>?
    ) -> Int32
  private typealias SessionFreeFn = @convention(c) (UnsafeMutableRawPointer?) -> Void
  private typealias SetAbortFn =
    @convention(c) (
      UnsafeMutableRawPointer?,
      (@convention(c) (UnsafeMutableRawPointer?) -> Bool)?,
      UnsafeMutableRawPointer?
    ) -> Void
  private typealias RunFn =
    @convention(c) (
      UnsafeMutableRawPointer?,
      UnsafePointer<Float>?,
      Int32,
      UnsafeRawPointer?
    ) -> Int32
  private typealias FullTextFn =
    @convention(c) (
      UnsafeMutableRawPointer?
    ) -> UnsafePointer<CChar>?

  static let expectedVersion = "0.1.3"
  private static let transcribeOK: Int32 = 0
  private static let featureInitialPrompt: Int32 = 0
  private static let extensionSlotRun: Int32 = 0
  private static let whisperRunExtensionKind: UInt32 = 1_314_015_319

  private let library: T3TranscribeLibrary
  private var model: UnsafeMutableRawPointer?
  private var session: UnsafeMutableRawPointer?
  private let abortState = T3AbortState()
  let capabilities: T3RecognizerCapabilities

  init(modelURL: URL) throws {
    library = try T3TranscribeLibrary()

    let versionFn: VersionFn = try library.function("transcribe_version")
    let version = versionFn().map(String.init(cString:)) ?? ""
    guard version.split(separator: "+").first.map(String.init) == Self.expectedVersion else {
      throw T3TranscribeError.native(
        "transcribe.cpp version \(version.isEmpty ? "unknown" : version) does not match \(Self.expectedVersion)."
      )
    }
    try library.validateABI()

    let initializeBackends: StatusFn = try library.function("transcribe_init_backends_default")
    try Self.check(initializeBackends(), library: library, operation: "initialize backends")

    let modelParams = Self.buffer(size: 16)
    defer { modelParams.deallocate() }
    let initializeModelParams: InitStructFn = try library.function(
      "transcribe_model_load_params_init"
    )
    initializeModelParams(modelParams)
    try T3NativeABI.validateInitializedStruct(
      modelParams,
      name: "transcribe_model_load_params",
      expectedSize: 16
    )

    let loadModel: ModelLoadFn = try library.function("transcribe_model_load_file")
    var loadedModel: UnsafeMutableRawPointer?
    let loadStatus = modelURL.path.withCString {
      loadModel($0, UnsafeRawPointer(modelParams), &loadedModel)
    }
    try Self.check(loadStatus, library: library, operation: "load model")
    guard let loadedModel else {
      throw T3TranscribeError.native("transcribe.cpp returned an empty model handle.")
    }
    model = loadedModel

    do {
      capabilities = try Self.readCapabilities(model: loadedModel, library: library)
      let sessionParams = Self.buffer(size: 24)
      defer { sessionParams.deallocate() }
      let initializeSessionParams: InitStructFn = try library.function(
        "transcribe_session_params_init"
      )
      initializeSessionParams(sessionParams)
      try T3NativeABI.validateInitializedStruct(
        sessionParams,
        name: "transcribe_session_params",
        expectedSize: 24
      )
      let initializeSession: SessionInitFn = try library.function("transcribe_session_init")
      var loadedSession: UnsafeMutableRawPointer?
      try Self.check(
        initializeSession(loadedModel, UnsafeRawPointer(sessionParams), &loadedSession),
        library: library,
        operation: "create session"
      )
      guard let loadedSession else {
        throw T3TranscribeError.native("transcribe.cpp returned an empty session handle.")
      }
      session = loadedSession
      let setAbort: SetAbortFn = try library.function("transcribe_set_abort_callback")
      setAbort(
        loadedSession,
        t3AbortCallback,
        Unmanaged.passUnretained(abortState).toOpaque()
      )
    } catch {
      let freeModel: ModelFreeFn? = try? library.function("transcribe_model_free")
      freeModel?(loadedModel)
      model = nil
      throw error
    }
  }

  deinit {
    if let session {
      let freeSession: SessionFreeFn? = try? library.function("transcribe_session_free")
      freeSession?(session)
    }
    if let model {
      let freeModel: ModelFreeFn? = try? library.function("transcribe_model_free")
      freeModel?(model)
    }
  }

  func transcribe(_ samples: [Float], language: String?, promptHint: String?) throws -> String {
    guard let session, let model else {
      throw T3TranscribeError.native("The transcribe.cpp session is closed.")
    }
    let runParams = Self.buffer(size: 64)
    defer { runParams.deallocate() }
    let initializeRunParams: InitStructFn = try library.function("transcribe_run_params_init")
    initializeRunParams(runParams)
    try T3NativeABI.validateInitializedStruct(
      runParams,
      name: "transcribe_run_params",
      expectedSize: 64
    )

    let run: RunFn = try library.function("transcribe_run")
    let invoke = { (languagePointer: UnsafePointer<CChar>?, promptPointer: UnsafePointer<CChar>?) throws -> Int32 in
      runParams
        .advanced(by: 24)
        .assumingMemoryBound(to: UnsafePointer<CChar>?.self)
        .pointee = languagePointer

      var whisperExtension: UnsafeMutableRawPointer?
      if let promptPointer, self.capabilities.supportsInitialPrompt {
        let acceptsExtension: ModelAcceptsExtensionFn = try self.library.function(
          "transcribe_model_accepts_ext_kind"
        )
        if acceptsExtension(
          model,
          Self.extensionSlotRun,
          Self.whisperRunExtensionKind
        ) {
          let extensionBuffer = Self.buffer(size: T3NativeABI.whisperRunExtensionSize)
          whisperExtension = extensionBuffer
          let initializeExtension: InitStructFn = try self.library.function(
            "transcribe_whisper_run_ext_init"
          )
          initializeExtension(extensionBuffer)
          try T3NativeABI.validateInitializedStruct(
            extensionBuffer,
            name: "transcribe_whisper_run_ext",
            expectedSize: T3NativeABI.whisperRunExtensionSize
          )
          extensionBuffer
            .advanced(by: 16)
            .assumingMemoryBound(to: UnsafePointer<CChar>?.self)
            .pointee = promptPointer
          runParams
            .advanced(by: 48)
            .assumingMemoryBound(to: UnsafeMutableRawPointer?.self)
            .pointee = extensionBuffer
        }
      }
      defer { whisperExtension?.deallocate() }
      return samples.withUnsafeBufferPointer {
        run(session, $0.baseAddress, Int32($0.count), UnsafeRawPointer(runParams))
      }
    }

    let normalizedLanguage = language.flatMap { $0.isEmpty ? nil : $0 }
    let normalizedPrompt = promptHint.flatMap { $0.isEmpty ? nil : $0 }
    let status: Int32
    switch (normalizedLanguage, normalizedPrompt) {
    case (.some(let language), .some(let prompt)):
      status = try language.withCString { languagePointer in
        try prompt.withCString { promptPointer in
          try invoke(languagePointer, promptPointer)
        }
      }
    case (.some(let language), .none):
      status = try language.withCString { languagePointer in
        try invoke(languagePointer, nil)
      }
    case (.none, .some(let prompt)):
      status = try prompt.withCString { promptPointer in
        try invoke(nil, promptPointer)
      }
    case (.none, .none):
      status = try invoke(nil, nil)
    }
    try Self.check(status, library: library, operation: "transcribe audio")
    let fullText: FullTextFn = try library.function("transcribe_full_text")
    return fullText(session).map(String.init(cString:))?.trimmingCharacters(
      in: .whitespacesAndNewlines)
      ?? ""
  }

  func cancel() {
    abortState.abort()
  }

  private static func readCapabilities(
    model: UnsafeMutableRawPointer,
    library: T3TranscribeLibrary
  ) throws -> T3RecognizerCapabilities {
    let buffer = Self.buffer(size: 56)
    defer { buffer.deallocate() }
    let initialize: InitStructFn = try library.function("transcribe_capabilities_init")
    initialize(buffer)
    try T3NativeABI.validateInitializedStruct(
      buffer,
      name: "transcribe_capabilities",
      expectedSize: 56
    )
    let read: ModelCapabilitiesFn = try library.function("transcribe_model_get_capabilities")
    try check(read(model, buffer), library: library, operation: "read model capabilities")

    let languageCount = Int(buffer.advanced(by: 12).assumingMemoryBound(to: Int32.self).pointee)
    let languageArray =
      buffer
      .advanced(by: 16)
      .assumingMemoryBound(to: UnsafeMutableRawPointer?.self)
      .pointee
    var languages: [String] = []
    if languageCount > 0, let languageArray {
      let pointers = languageArray.assumingMemoryBound(to: UnsafePointer<CChar>?.self)
      for index in 0..<languageCount {
        if let pointer = pointers[index] {
          languages.append(String(cString: pointer))
        }
      }
    }
    let supports: ModelSupportsFn = try library.function("transcribe_model_supports")
    return T3RecognizerCapabilities(
      languages: languages,
      supportsLanguageDetect: buffer.advanced(by: 28).assumingMemoryBound(to: Bool.self).pointee,
      supportsInitialPrompt: supports(model, featureInitialPrompt),
      supportsStreaming: buffer.advanced(by: 30).assumingMemoryBound(to: Bool.self).pointee
    )
  }

  private static func buffer(size: Int) -> UnsafeMutableRawPointer {
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 8)
    buffer.initializeMemory(as: UInt8.self, repeating: 0, count: size)
    return buffer
  }

  private static func check(
    _ status: Int32,
    library: T3TranscribeLibrary,
    operation: String
  ) throws {
    guard status != transcribeOK else { return }
    let statusString: StatusStringFn = try library.function("transcribe_status_string")
    let detail = statusString(status).map(String.init(cString:)) ?? "status \(status)"
    throw T3TranscribeError.native("Could not \(operation): \(detail).")
  }
}

final class T3TranscribeLibrary {
  private var handle: UnsafeMutableRawPointer?
  private let ownsHandle: Bool

  init() throws {
    let processHandle = dlopen(nil, RTLD_NOW)
    if let processHandle, dlsym(processHandle, "transcribe_version") != nil {
      handle = processHandle
      ownsHandle = false
      return
    }
    if let processHandle {
      dlclose(processHandle)
    }

    let frameworks = Bundle.main.privateFrameworksURL
    let candidates = [
      frameworks?.appendingPathComponent("CTranscribe.framework/CTranscribe").path,
      frameworks?.appendingPathComponent("TranscribeCpp.framework/TranscribeCpp").path,
      frameworks?.appendingPathComponent("transcribe.framework/transcribe").path,
      Bundle.main.path(forResource: "TranscribeCpp", ofType: "framework"),
    ].compactMap { $0 }

    for candidate in candidates {
      if let loaded = dlopen(candidate, RTLD_NOW | RTLD_LOCAL) {
        handle = loaded
        ownsHandle = true
        return
      }
    }
    handle = nil
    ownsHandle = false
    throw T3TranscribeError.nativeEngineUnavailable
  }

  deinit {
    if ownsHandle, let handle {
      dlclose(handle)
    }
  }

  func function<T>(_ name: String) throws -> T {
    guard let handle, let symbol = dlsym(handle, name) else {
      throw T3TranscribeError.native("The transcribe.cpp symbol \(name) is missing.")
    }
    return unsafeBitCast(symbol, to: T.self)
  }

  func validateABI() throws {
    typealias LayoutFn = @convention(c) (Int32) -> Int
    let size: LayoutFn = try function("transcribe_abi_struct_size")
    let alignment: LayoutFn = try function("transcribe_abi_struct_align")
    try T3NativeABI.validate(
      size: { size($0) },
      alignment: { alignment($0) }
    )
  }

  static var isAvailable: Bool {
    typealias VersionFn = @convention(c) () -> UnsafePointer<CChar>?
    guard
      let library = try? T3TranscribeLibrary(),
      let versionFn: VersionFn = try? library.function("transcribe_version"),
      let versionPointer = versionFn(),
      (try? library.validateABI()) != nil
    else {
      return false
    }
    let version = String(cString: versionPointer)
    return version.split(separator: "+").first.map(String.init)
      == T3NativeRecognizer.expectedVersion
  }
}
