import Foundation

enum T3PCMCodec {
  static func int16Base64(_ samples: [Float]) -> String {
    int16Data(samples).base64EncodedString()
  }

  static func int16Data(_ samples: [Float]) -> Data {
    var data = Data(capacity: samples.count * MemoryLayout<Int16>.size)
    for sample in samples {
      let clamped = max(-1, min(1, sample))
      var value = Int16((clamped * Float(Int16.max)).rounded()).littleEndian
      withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
    }
    return data
  }
}
