import Foundation

/// Reserves native capture before the first async permission/model boundary.
///
/// A unique token prevents an old cancelled start from becoming current again
/// when a later session happens to reuse the same client-provided session id.
final class T3CaptureReservation: @unchecked Sendable {
  struct Token: Equatable {
    fileprivate let id = UUID()
    let sessionId: String
  }

  private let lock = NSLock()
  private var current: Token?

  func reserve(sessionId: String) throws -> Token {
    lock.lock()
    defer { lock.unlock() }
    guard current == nil else {
      throw T3TranscribeError.sessionActive
    }
    let token = Token(sessionId: sessionId)
    current = token
    return token
  }

  func isCurrent(_ token: Token) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return current == token
  }

  @discardableResult
  func cancelCurrent() -> Token? {
    lock.lock()
    defer { lock.unlock() }
    let token = current
    current = nil
    return token
  }

  func clear(_ token: Token) {
    lock.lock()
    if current == token {
      current = nil
    }
    lock.unlock()
  }
}
