// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "T3TranscribeNativeTests",
  platforms: [.iOS("18.0"), .macOS("13.0")],
  products: [
    .library(name: "T3ChunkedEngineCore", targets: ["T3ChunkedEngineCore"])
  ],
  targets: [
    .target(
      name: "T3ChunkedEngineCore",
      path: "ios",
      exclude: [
        "T3AudioCaptureController.swift",
        "T3DeviceCapability.swift",
        "T3ModelDownloadManager.swift",
        "T3NativeRecognizer.swift",
        "T3TranscribeAppDelegateSubscriber.swift",
        "T3TranscribeModule.swift",
        "T3TranscribeModuleTests.swift",
      ],
      sources: [
        "T3CaptureReservation.swift",
        "T3CaptureLifecycle.swift",
        "T3ChunkedEngine.swift",
        "T3LanguageResolver.swift",
        "T3ModelFileIntegrity.swift",
        "T3NativeABI.swift",
        "T3PCMCodec.swift",
      ]
    ),
    .testTarget(
      name: "T3ChunkedEngineCoreTests",
      dependencies: ["T3ChunkedEngineCore"],
      path: "ios",
      exclude: [
        "T3AudioCaptureController.swift",
        "T3CaptureReservation.swift",
        "T3CaptureLifecycle.swift",
        "T3ChunkedEngine.swift",
        "T3DeviceCapability.swift",
        "T3LanguageResolver.swift",
        "T3ModelFileIntegrity.swift",
        "T3ModelDownloadManager.swift",
        "T3NativeABI.swift",
        "T3NativeRecognizer.swift",
        "T3PCMCodec.swift",
        "T3TranscribeAppDelegateSubscriber.swift",
        "T3TranscribeModule.swift",
      ],
      sources: ["T3TranscribeModuleTests.swift"]
    ),
  ]
)
