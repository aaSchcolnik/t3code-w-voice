# transcribe.cpp iOS artifact

This directory is version-locked to transcribe.cpp `0.1.3`, matching the
desktop and server npm binding.

The vendored `CTranscribe.xcframework` is the upstream v0.1.3 release asset, renamed to
match its contained framework and binary so CocoaPods links `CTranscribe` correctly:

`Vendor/transcribe-cpp/CTranscribe.xcframework`

- Source: `https://github.com/handy-computer/transcribe.cpp/releases/download/v0.1.3/TranscribeCpp.xcframework.zip`
- SHA-256: `b7a3442e2f3552cac1ee71b5e164934dd4db243f6b4b16b1e3e3ed5d1645eefd`

The module deliberately does not substitute the macOS dylibs from the npm
package: they are not valid iOS slices. Capture-only server fallback remains
available if a downstream build intentionally omits the framework.
