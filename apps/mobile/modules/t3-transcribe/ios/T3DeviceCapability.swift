import Darwin
import Foundation
import Metal

struct T3DeviceCapability {
  let allowed: Bool
  let reason: String?
  let availableMemoryMb: Int
  let physicalMemoryMb: Int
  let supportsApple7: Bool
  let nativeEngineAvailable: Bool

  var eventBody: [String: Any] {
    var body: [String: Any] = [
      "allowed": allowed,
      "availableMemoryMb": availableMemoryMb,
      "physicalMemoryMb": physicalMemoryMb,
      "supportsApple7": supportsApple7,
      "nativeEngineAvailable": nativeEngineAvailable,
    ]
    if let reason {
      body["reason"] = reason
    }
    return body
  }

  static func inspect(minRamMb: Int, requiresGpuFamily: String?) -> T3DeviceCapability {
    let physicalMemoryMb = Int(ProcessInfo.processInfo.physicalMemory / 1_048_576)
    let availableMemoryMb = Int(availableProcessMemory() / 1_048_576)
    let supportsApple7 = MTLCreateSystemDefaultDevice()?.supportsFamily(.apple7) == true
    let nativeEngineAvailable = T3TranscribeLibrary.isAvailable

    let reason: String?
    if !nativeEngineAvailable {
      reason = "This build does not include compatible transcribe.cpp 0.1.3 iOS support."
    } else if physicalMemoryMb < minRamMb {
      reason = "This model needs at least \(minRamMb) MB of device memory."
    } else if availableMemoryMb < min(minRamMb, max(768, minRamMb / 2)) {
      reason = "There is not enough memory available to load this model safely."
    } else if requiresGpuFamily == "apple7" && !supportsApple7 {
      reason = "This model requires an Apple 7-or-newer GPU."
    } else {
      reason = nil
    }

    return T3DeviceCapability(
      allowed: reason == nil,
      reason: reason,
      availableMemoryMb: availableMemoryMb,
      physicalMemoryMb: physicalMemoryMb,
      supportsApple7: supportsApple7,
      nativeEngineAvailable: nativeEngineAvailable
    )
  }

  private static func availableProcessMemory() -> UInt64 {
    typealias AvailableMemoryFn = @convention(c) () -> UInt64
    guard let handle = dlopen(nil, RTLD_NOW) else {
      return ProcessInfo.processInfo.physicalMemory
    }
    defer { dlclose(handle) }
    guard let symbol = dlsym(handle, "os_proc_available_memory") else {
      return ProcessInfo.processInfo.physicalMemory
    }
    let available = unsafeBitCast(symbol, to: AvailableMemoryFn.self)
    return available()
  }
}
