import Foundation

enum T3LanguageResolver {
  static func resolve(
    configuredLanguage: String?,
    localeIdentifier: String,
    capabilities: T3RecognizerCapabilities
  ) throws -> String? {
    let supported = Set(capabilities.languages.map(normalize))
    let configured = configuredLanguage.map(normalize).flatMap { $0.isEmpty ? nil : $0 }

    if let configured {
      guard supported.isEmpty || supported.contains(configured) else {
        throw T3TranscribeError.capability(
          "The selected model does not support the configured language “\(configured)”."
        )
      }
      return configured
    }

    if capabilities.supportsLanguageDetect {
      return nil
    }

    let localeLanguage = Locale(identifier: localeIdentifier).language.languageCode?
      .identifier
      .lowercased()
    if let localeLanguage, supported.contains(localeLanguage) {
      return localeLanguage
    }

    throw T3TranscribeError.capability(
      "The selected model cannot detect language automatically and does not support the device language."
    )
  }

  private static func normalize(_ value: String) -> String {
    value
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
      .split(separator: "-", maxSplits: 1)
      .first
      .map(String.init) ?? ""
  }
}
