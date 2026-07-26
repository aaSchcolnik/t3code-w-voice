import Foundation

enum T3CaptureLifecycleEvent {
  case audioInterruption
  case inputRouteLost
  case mediaServicesReset
  case enteredBackground

  var message: String {
    switch self {
    case .audioInterruption:
      return "Voice capture ended because the audio session was interrupted."
    case .inputRouteLost:
      return "Voice capture ended because the microphone route changed."
    case .mediaServicesReset:
      return "Voice capture ended because iOS reset its audio services."
    case .enteredBackground:
      return "Voice capture ended because the app moved to the background."
    }
  }
}

struct T3CaptureTerminalFailure: Equatable {
  let sessionId: String
  let message: String
}

final class T3CaptureLifecycleGuard: @unchecked Sendable {
  private let lock = NSLock()
  private var activeSessionId: String?
  private var isTerminating = false

  func begin(sessionId: String) {
    lock.lock()
    activeSessionId = sessionId
    isTerminating = false
    lock.unlock()
  }

  func clear(sessionId: String) {
    lock.lock()
    if activeSessionId == sessionId {
      activeSessionId = nil
      isTerminating = false
    }
    lock.unlock()
  }

  func terminate(for event: T3CaptureLifecycleEvent) -> T3CaptureTerminalFailure? {
    lock.lock()
    defer { lock.unlock() }
    guard let activeSessionId, !isTerminating else { return nil }
    isTerminating = true
    return T3CaptureTerminalFailure(
      sessionId: activeSessionId,
      message: event.message
    )
  }
}
