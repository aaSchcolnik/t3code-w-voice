import ExpoModulesCore

private enum T3BackgroundSessionCompletions {
  private static let lock = NSLock()
  private static var handlers: [String: () -> Void] = [:]

  static func store(identifier: String, handler: @escaping () -> Void) {
    lock.lock()
    handlers[identifier] = handler
    lock.unlock()
  }

  static func finish(identifier: String) {
    lock.lock()
    let handler = handlers.removeValue(forKey: identifier)
    lock.unlock()
    guard let handler else { return }
    DispatchQueue.main.async(execute: handler)
  }
}

public final class T3TranscribeAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    T3BackgroundSessionCompletions.store(
      identifier: identifier,
      handler: completionHandler
    )
  }
}

extension T3ModelDownloadManager {
  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let identifier = session.configuration.identifier else { return }
    T3BackgroundSessionCompletions.finish(identifier: identifier)
  }
}
