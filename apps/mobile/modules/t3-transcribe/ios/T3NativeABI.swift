import Foundation

enum T3NativeABI {
  struct Layout: Equatable {
    let id: Int32
    let name: String
    let size: Int
    let alignment: Int
  }

  static let version013Layouts = [
    Layout(id: 0, name: "transcribe_model_load_params", size: 16, alignment: 8),
    Layout(id: 1, name: "transcribe_session_params", size: 24, alignment: 8),
    Layout(id: 2, name: "transcribe_run_params", size: 64, alignment: 8),
    Layout(id: 4, name: "transcribe_capabilities", size: 56, alignment: 8),
    Layout(id: 12, name: "transcribe_ext", size: 16, alignment: 8),
  ]

  static let whisperRunExtensionSize = 80
  static let whisperRunExtensionAlignment = 8

  static func validate(
    size: (Int32) -> Int,
    alignment: (Int32) -> Int
  ) throws {
    for expected in version013Layouts {
      let actualSize = size(expected.id)
      let actualAlignment = alignment(expected.id)
      guard actualSize > 0, actualAlignment > 0 else {
        throw T3TranscribeError.native(
          "Could not verify the native ABI layout for \(expected.name)."
        )
      }
      guard actualSize == expected.size, actualAlignment == expected.alignment else {
        throw T3TranscribeError.native(
          "Native ABI mismatch for \(expected.name): expected size/alignment "
            + "\(expected.size)/\(expected.alignment), received "
            + "\(actualSize)/\(actualAlignment)."
        )
      }
    }
  }

  static func validateInitializedStruct(
    _ buffer: UnsafeRawPointer,
    name: String,
    expectedSize: Int
  ) throws {
    let stampedSize = Int(buffer.load(as: UInt64.self))
    guard stampedSize == expectedSize else {
      throw T3TranscribeError.native(
        "Native ABI mismatch for \(name): expected initialized size "
          + "\(expectedSize), received \(stampedSize)."
      )
    }
  }
}
