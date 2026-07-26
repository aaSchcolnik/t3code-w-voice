import CryptoKit
import Darwin
import Foundation

struct T3VerifiedFileIdentity: Codable, Equatable {
  let device: UInt64
  let inode: UInt64
  let size: Int64
  let modificationSeconds: Int64
  let modificationNanoseconds: Int64
  let statusChangeSeconds: Int64
  let statusChangeNanoseconds: Int64
}

enum T3ModelFileIntegrity {
  static func identity(of url: URL) throws -> T3VerifiedFileIdentity {
    var info = Darwin.stat()
    guard lstat(url.path, &info) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    guard (info.st_mode & S_IFMT) == S_IFREG else {
      throw T3TranscribeError.download("The installed model is not a regular file.")
    }
    return T3VerifiedFileIdentity(
      device: UInt64(info.st_dev),
      inode: UInt64(info.st_ino),
      size: Int64(info.st_size),
      modificationSeconds: Int64(info.st_mtimespec.tv_sec),
      modificationNanoseconds: Int64(info.st_mtimespec.tv_nsec),
      statusChangeSeconds: Int64(info.st_ctimespec.tv_sec),
      statusChangeNanoseconds: Int64(info.st_ctimespec.tv_nsec)
    )
  }

  static func verify(
    _ url: URL,
    expectedSize: Int64,
    expectedSHA256: String
  ) throws -> T3VerifiedFileIdentity {
    let before = try identity(of: url)
    guard before.size == expectedSize else {
      throw T3TranscribeError.download(
        "Model verification failed. Expected \(expectedSize) bytes, received \(before.size)."
      )
    }
    let digest = try sha256(of: url)
    let after = try identity(of: url)
    guard before == after else {
      throw T3TranscribeError.download("The model file changed while it was being verified.")
    }
    guard digest == expectedSHA256.lowercased() else {
      throw T3TranscribeError.download(
        "Model verification failed. Expected \(expectedSHA256), received \(digest)."
      )
    }
    return after
  }

  static func sha256(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let data = try handle.read(upToCount: 4 * 1_048_576) ?? Data()
      if data.isEmpty { break }
      hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
