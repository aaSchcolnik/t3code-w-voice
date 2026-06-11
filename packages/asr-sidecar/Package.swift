// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "t3-asr-sidecar",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.5.0")
    ],
    targets: [
        .executableTarget(
            name: "t3-asr-sidecar",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/t3-asr-sidecar"
        )
    ]
)
