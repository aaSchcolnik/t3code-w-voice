require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
framework = File.join(__dir__, 'Vendor/transcribe-cpp/CTranscribe.xcframework')

Pod::Spec.new do |s|
  s.name = 'T3TranscribeNative'
  s.version = package['version']
  s.summary = 'On-device voice capture and transcription for T3 Code mobile.'
  s.description = 'Expo module for microphone capture, model downloads, device gating, and transcribe.cpp inference.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '18.0' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.exclude_files = 'ios/**/*Tests.swift'
  s.vendored_frameworks = 'Vendor/transcribe-cpp/CTranscribe.xcframework' if File.exist?(framework)
  s.frameworks = 'AVFAudio', 'Metal'
  s.libraries = 'c++'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
