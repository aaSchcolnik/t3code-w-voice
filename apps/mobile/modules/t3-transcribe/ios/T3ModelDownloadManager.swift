import Darwin
import Foundation

private struct T3ModelDownloadMetadata: Codable {
  let modelId: String
  let quantizationId: String
  let sourceURL: URL
  let sha256: String
  let totalBytes: Int64
  var status: String
  var downloadedBytes: Int64
  var error: String?
  var verifiedIdentity: T3VerifiedFileIdentity?
}

final class T3ModelDownloadManager: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  typealias EventSink = ([String: Any]) -> Void

  private let fileManager = FileManager.default
  private let queue = DispatchQueue(label: "com.t3tools.transcribe.downloads")
  private let verificationQueue = DispatchQueue(
    label: "com.t3tools.transcribe.verification",
    qos: .utility
  )
  private var metadata: [String: T3ModelDownloadMetadata] = [:]
  private var tasks: [String: URLSessionDownloadTask] = [:]
  private var verifyingInstallations = Set<String>()
  private var eventSink: EventSink?

  private lazy var session: URLSession = {
    let identifier = "\(Bundle.main.bundleIdentifier ?? "com.t3tools.t3code").voice-models"
    let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    configuration.allowsCellularAccess = true
    configuration.waitsForConnectivity = true
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()

  override init() {
    super.init()
    queue.sync {
      try? prepareModelsDirectory()
      loadRegistry()
    }
    verifyRestoredInstallations()
    session.getAllTasks { [weak self] restored in
      guard let self else { return }
      self.queue.async {
        for case let task as URLSessionDownloadTask in restored {
          guard let key = task.taskDescription, self.metadata[key] != nil else {
            task.cancel()
            continue
          }
          self.tasks[key] = task
          self.update(key: key, status: "downloading", error: nil)
        }
      }
    }
  }

  func setEventSink(_ sink: EventSink?) {
    queue.async { [weak self] in
      self?.eventSink = sink
    }
  }

  func states() -> [[String: Any]] {
    queue.sync {
      revalidateInstalledIdentities()
      return metadata.values
        .sorted {
          key(modelId: $0.modelId, quantizationId: $0.quantizationId)
            < key(modelId: $1.modelId, quantizationId: $1.quantizationId)
        }
        .map(Self.eventBody)
    }
  }

  func modelURL(modelId: String, quantizationId: String) -> URL? {
    queue.sync {
      let targetKey = key(modelId: modelId, quantizationId: quantizationId)
      let url = finalURL(modelId: modelId, quantizationId: quantizationId)
      guard
        let entry = metadata[targetKey],
        entry.status == "done",
        let verifiedIdentity = entry.verifiedIdentity,
        (try? T3ModelFileIntegrity.identity(of: url)) == verifiedIdentity
      else {
        scheduleInstalledVerificationIfNeeded(key: targetKey)
        return nil
      }
      return url
    }
  }

  func start(
    modelId: String,
    quantizationId: String,
    sourceURL: String,
    sha256: String,
    totalBytes: Int64
  ) throws {
    guard let url = URL(string: sourceURL), ["https", "http"].contains(url.scheme?.lowercased())
    else {
      throw T3TranscribeError.invalidArgument("The model download URL is invalid.")
    }
    guard totalBytes > 0,
      sha256.range(of: #"^[0-9a-fA-F]{64}$"#, options: .regularExpression) != nil
    else {
      throw T3TranscribeError.invalidArgument("The model size or SHA-256 is invalid.")
    }

    try queue.sync {
      try prepareModelsDirectory()
      let targetKey = key(modelId: modelId, quantizationId: quantizationId)
      let installedURL = finalURL(modelId: modelId, quantizationId: quantizationId)
      if fileSize(installedURL) == totalBytes {
        do {
          let identity = try T3ModelFileIntegrity.verify(
            installedURL,
            expectedSize: totalBytes,
            expectedSHA256: sha256
          )
          metadata[targetKey] = T3ModelDownloadMetadata(
            modelId: modelId,
            quantizationId: quantizationId,
            sourceURL: url,
            sha256: sha256.lowercased(),
            totalBytes: totalBytes,
            status: "done",
            downloadedBytes: totalBytes,
            error: nil,
            verifiedIdentity: identity
          )
          persistRegistry()
          emit(targetKey)
          return
        } catch {
          try? fileManager.removeItem(at: installedURL)
        }
      }
      if fileManager.fileExists(atPath: installedURL.path) {
        try fileManager.removeItem(at: installedURL)
      }
      guard tasks[targetKey] == nil else { return }

      var entry = T3ModelDownloadMetadata(
        modelId: modelId,
        quantizationId: quantizationId,
        sourceURL: url,
        sha256: sha256.lowercased(),
        totalBytes: totalBytes,
        status: "queued",
        downloadedBytes: metadata[targetKey]?.downloadedBytes ?? 0,
        error: nil,
        verifiedIdentity: nil
      )
      metadata[targetKey] = entry
      let available =
        try modelsDirectory.resourceValues(
          forKeys: [.volumeAvailableCapacityForImportantUsageKey]
        ).volumeAvailableCapacityForImportantUsage ?? 0
      let required = max(totalBytes + 64 * 1_048_576, Int64(Double(totalBytes) * 1.1))
      guard available >= required else {
        removeTransientFiles(for: entry)
        entry.status = "error"
        entry.downloadedBytes = 0
        entry.error = "disk_full"
        metadata[targetKey] = entry
        persistRegistry()
        emit(targetKey)
        throw T3TranscribeError.download(
          "Not enough free space. This download needs \(required / 1_048_576) MB."
        )
      }
      let resumeURL = self.resumeURL(modelId: modelId, quantizationId: quantizationId)
      let task: URLSessionDownloadTask
      if let resumeData = try? Data(contentsOf: resumeURL), !resumeData.isEmpty {
        task = session.downloadTask(withResumeData: resumeData)
      } else {
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        task = session.downloadTask(with: request)
      }
      task.taskDescription = targetKey
      tasks[targetKey] = task
      entry.status = "downloading"
      metadata[targetKey] = entry
      persistRegistry()
      emit(targetKey)
      task.resume()
    }
  }

  func pause(modelId: String, quantizationId: String) {
    queue.async { [weak self] in
      guard let self else { return }
      let targetKey = self.key(modelId: modelId, quantizationId: quantizationId)
      guard let task = self.tasks.removeValue(forKey: targetKey) else { return }
      task.cancel { resumeData in
        self.queue.async {
          if let resumeData {
            try? resumeData.write(
              to: self.resumeURL(modelId: modelId, quantizationId: quantizationId),
              options: .atomic
            )
          }
          self.update(key: targetKey, status: "paused", error: nil)
        }
      }
    }
  }

  func cancel(modelId: String, quantizationId: String) {
    queue.async { [weak self] in
      guard let self else { return }
      let targetKey = self.key(modelId: modelId, quantizationId: quantizationId)
      self.tasks.removeValue(forKey: targetKey)?.cancel()
      try? self.fileManager.removeItem(
        at: self.resumeURL(modelId: modelId, quantizationId: quantizationId)
      )
      try? self.fileManager.removeItem(
        at: self.partialURL(modelId: modelId, quantizationId: quantizationId)
      )
      self.metadata.removeValue(forKey: targetKey)
      self.persistRegistry()
      self.eventSink?([
        "kind": "removed",
        "modelId": modelId,
        "quantizationId": quantizationId,
      ])
    }
  }

  func remove(modelId: String, quantizationId: String) {
    cancel(modelId: modelId, quantizationId: quantizationId)
    queue.async { [weak self] in
      guard let self else { return }
      try? self.fileManager.removeItem(
        at: self.finalURL(modelId: modelId, quantizationId: quantizationId)
      )
    }
  }

  func urlSession(
    _: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData _: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite _: Int64
  ) {
    guard let targetKey = downloadTask.taskDescription else { return }
    queue.async { [weak self] in
      guard let self, var entry = self.metadata[targetKey] else { return }
      entry.status = "downloading"
      entry.downloadedBytes = totalBytesWritten
      self.metadata[targetKey] = entry
      self.persistRegistry()
      self.emit(targetKey)
    }
  }

  func urlSession(
    _: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    guard let targetKey = downloadTask.taskDescription else { return }
    var verification: (entry: T3ModelDownloadMetadata, partial: URL)?
    queue.sync {
      guard let entry = metadata[targetKey] else { return }
      tasks.removeValue(forKey: targetKey)
      let partial = partialURL(
        modelId: entry.modelId,
        quantizationId: entry.quantizationId
      )
      do {
        try? fileManager.removeItem(at: partial)
        // URLSession owns `location` only for the duration of this delegate
        // callback, so move it before returning rather than queueing the move.
        try fileManager.moveItem(at: location, to: partial)
        try excludeFromBackup(partial)
        update(
          key: targetKey,
          status: "verifying",
          downloadedBytes: entry.totalBytes,
          error: nil
        )
        verification = (entry, partial)
      } catch {
        handleDownloadFailure(error, key: targetKey, entry: entry)
      }
    }
    guard let verification else { return }

    verificationQueue.async { [weak self] in
      guard let self else { return }
      do {
        _ = try T3ModelFileIntegrity.verify(
          verification.partial,
          expectedSize: verification.entry.totalBytes,
          expectedSHA256: verification.entry.sha256
        )
        let final = self.finalURL(
          modelId: verification.entry.modelId,
          quantizationId: verification.entry.quantizationId
        )
        try? self.fileManager.removeItem(at: final)
        try self.fileManager.moveItem(at: verification.partial, to: final)
        try self.excludeFromBackup(final)
        let verifiedIdentity = try T3ModelFileIntegrity.identity(of: final)
        try? self.fileManager.removeItem(
          at: self.resumeURL(
            modelId: verification.entry.modelId,
            quantizationId: verification.entry.quantizationId
          )
        )
        self.queue.async {
          self.update(
            key: targetKey,
            status: "done",
            downloadedBytes: verification.entry.totalBytes,
            error: nil,
            verifiedIdentity: verifiedIdentity
          )
        }
      } catch {
        self.queue.async {
          self.handleDownloadFailure(
            error,
            key: targetKey,
            entry: verification.entry
          )
        }
      }
    }
  }

  func urlSession(
    _: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard let error, let targetKey = task.taskDescription else { return }
    queue.async { [weak self] in
      guard let self, let entry = self.metadata[targetKey] else { return }
      self.tasks.removeValue(forKey: targetKey)
      if entry.status == "paused" || (error as NSError).code == NSURLErrorCancelled {
        return
      }
      if let resumeData = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
        if !Self.isDiskFull(error) {
          try? resumeData.write(
            to: self.resumeURL(
              modelId: entry.modelId,
              quantizationId: entry.quantizationId
            ),
            options: .atomic
          )
        }
      }
      self.handleDownloadFailure(error, key: targetKey, entry: entry)
    }
  }

  private var modelsDirectory: URL {
    let root = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return root.appendingPathComponent("VoiceModels", isDirectory: true)
  }

  private var registryURL: URL {
    modelsDirectory.appendingPathComponent("downloads.json")
  }

  private func key(modelId: String, quantizationId: String) -> String {
    "\(sanitize(modelId))--\(sanitize(quantizationId))"
  }

  private func finalURL(modelId: String, quantizationId: String) -> URL {
    modelsDirectory
      .appendingPathComponent(key(modelId: modelId, quantizationId: quantizationId))
      .appendingPathExtension("gguf")
  }

  private func partialURL(modelId: String, quantizationId: String) -> URL {
    finalURL(modelId: modelId, quantizationId: quantizationId).appendingPathExtension("part")
  }

  private func resumeURL(modelId: String, quantizationId: String) -> URL {
    finalURL(modelId: modelId, quantizationId: quantizationId).appendingPathExtension("resume")
  }

  private func sanitize(_ value: String) -> String {
    value.map { character in
      character.isLetter || character.isNumber || character == "-" || character == "_"
        ? character
        : "_"
    }.reduce(into: "", { $0.append($1) })
  }

  private func prepareModelsDirectory() throws {
    try fileManager.createDirectory(
      at: modelsDirectory,
      withIntermediateDirectories: true
    )
    try excludeFromBackup(modelsDirectory)
  }

  private func excludeFromBackup(_ url: URL) throws {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableURL = url
    try mutableURL.setResourceValues(values)
  }

  private func loadRegistry() {
    guard
      let data = try? Data(contentsOf: registryURL),
      let decoded = try? JSONDecoder().decode(
        [String: T3ModelDownloadMetadata].self,
        from: data
      )
    else {
      metadata = [:]
      return
    }
    metadata = decoded.mapValues { entry in
      let final = finalURL(
        modelId: entry.modelId,
        quantizationId: entry.quantizationId
      )
      if fileSize(final) == entry.totalBytes {
        let currentIdentity = try? T3ModelFileIntegrity.identity(of: final)
        let identityIsTrusted =
          entry.status == "done"
          && entry.verifiedIdentity != nil
          && entry.verifiedIdentity == currentIdentity
        return T3ModelDownloadMetadata(
          modelId: entry.modelId,
          quantizationId: entry.quantizationId,
          sourceURL: entry.sourceURL,
          sha256: entry.sha256,
          totalBytes: entry.totalBytes,
          status: identityIsTrusted ? "done" : "verifying",
          downloadedBytes: entry.totalBytes,
          error: nil,
          verifiedIdentity: identityIsTrusted ? currentIdentity : nil
        )
      }
      if fileManager.fileExists(atPath: final.path) {
        try? fileManager.removeItem(at: final)
      }
      return T3ModelDownloadMetadata(
        modelId: entry.modelId,
        quantizationId: entry.quantizationId,
        sourceURL: entry.sourceURL,
        sha256: entry.sha256,
        totalBytes: entry.totalBytes,
        status: entry.status == "verifying" ? "paused" : entry.status,
        downloadedBytes: entry.downloadedBytes,
        error: entry.error,
        verifiedIdentity: nil
      )
    }
  }

  private func verifyRestoredInstallations() {
    queue.async { [weak self] in
      guard let self else { return }
      for targetKey in self.metadata.keys where self.metadata[targetKey]?.status == "verifying" {
        self.scheduleInstalledVerificationIfNeeded(key: targetKey)
      }
    }
  }

  private func revalidateInstalledIdentities() {
    for (targetKey, entry) in metadata where entry.status == "done" {
      let url = finalURL(modelId: entry.modelId, quantizationId: entry.quantizationId)
      guard
        let verifiedIdentity = entry.verifiedIdentity,
        (try? T3ModelFileIntegrity.identity(of: url)) == verifiedIdentity
      else {
        scheduleInstalledVerificationIfNeeded(key: targetKey)
        continue
      }
    }
  }

  private func scheduleInstalledVerificationIfNeeded(key targetKey: String) {
    guard
      !verifyingInstallations.contains(targetKey),
      var entry = metadata[targetKey]
    else {
      return
    }
    let url = finalURL(modelId: entry.modelId, quantizationId: entry.quantizationId)
    guard fileManager.fileExists(atPath: url.path) else { return }
    entry.status = "verifying"
    entry.error = nil
    entry.verifiedIdentity = nil
    metadata[targetKey] = entry
    verifyingInstallations.insert(targetKey)
    persistRegistry()
    emit(targetKey)

    verificationQueue.async { [weak self] in
      guard let self else { return }
      let result = Result {
        try T3ModelFileIntegrity.verify(
          url,
          expectedSize: entry.totalBytes,
          expectedSHA256: entry.sha256
        )
      }
      self.queue.async {
        self.verifyingInstallations.remove(targetKey)
        guard
          let current = self.metadata[targetKey],
          current.sha256 == entry.sha256,
          current.totalBytes == entry.totalBytes
        else {
          return
        }
        switch result {
        case .success(let identity):
          self.update(
            key: targetKey,
            status: "done",
            downloadedBytes: entry.totalBytes,
            error: nil,
            verifiedIdentity: identity
          )
        case .failure(let error):
          try? self.fileManager.removeItem(at: url)
          self.update(
            key: targetKey,
            status: "error",
            downloadedBytes: entry.totalBytes,
            error: error.localizedDescription
          )
        }
      }
    }
  }

  private func persistRegistry() {
    guard let data = try? JSONEncoder().encode(metadata) else { return }
    try? data.write(to: registryURL, options: .atomic)
  }

  private func fileSize(_ url: URL) -> Int64? {
    guard
      let attributes = try? fileManager.attributesOfItem(atPath: url.path),
      let size = attributes[.size] as? NSNumber
    else {
      return nil
    }
    return size.int64Value
  }

  private func handleDownloadFailure(
    _ error: Error,
    key targetKey: String,
    entry: T3ModelDownloadMetadata
  ) {
    let diskFull = Self.isDiskFull(error)
    if diskFull {
      removeTransientFiles(for: entry)
    }
    update(
      key: targetKey,
      status: "error",
      downloadedBytes: diskFull ? 0 : entry.downloadedBytes,
      error: diskFull ? "disk_full" : error.localizedDescription
    )
  }

  private func removeTransientFiles(for entry: T3ModelDownloadMetadata) {
    try? fileManager.removeItem(
      at: partialURL(modelId: entry.modelId, quantizationId: entry.quantizationId)
    )
    try? fileManager.removeItem(
      at: resumeURL(modelId: entry.modelId, quantizationId: entry.quantizationId)
    )
  }

  private static func isDiskFull(_ error: Error) -> Bool {
    let nsError = error as NSError
    if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileWriteOutOfSpaceError {
      return true
    }
    if nsError.domain == NSPOSIXErrorDomain && nsError.code == Int(ENOSPC) {
      return true
    }
    return nsError.userInfo.values.contains { value in
      guard let nested = value as? Error else { return false }
      return isDiskFull(nested)
    }
  }

  private func update(
    key: String,
    status: String,
    downloadedBytes: Int64? = nil,
    error: String?,
    verifiedIdentity: T3VerifiedFileIdentity? = nil
  ) {
    guard let entry = metadata[key] else { return }
    metadata[key] = T3ModelDownloadMetadata(
      modelId: entry.modelId,
      quantizationId: entry.quantizationId,
      sourceURL: entry.sourceURL,
      sha256: entry.sha256,
      totalBytes: entry.totalBytes,
      status: status,
      downloadedBytes: downloadedBytes ?? entry.downloadedBytes,
      error: error,
      verifiedIdentity: status == "done" ? verifiedIdentity : nil
    )
    persistRegistry()
    emit(key)
  }

  private func emit(_ key: String) {
    guard let entry = metadata[key] else { return }
    eventSink?(["kind": "progress", "state": Self.eventBody(entry)])
  }

  private static func eventBody(_ entry: T3ModelDownloadMetadata) -> [String: Any] {
    var body: [String: Any] = [
      "modelId": entry.modelId,
      "quantizationId": entry.quantizationId,
      "status": entry.status,
      "downloadedBytes": entry.downloadedBytes,
      "totalBytes": entry.totalBytes,
    ]
    if let error = entry.error {
      body["error"] = error
    }
    return body
  }

}
