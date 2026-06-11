// t3-asr-sidecar — local speech-to-text sidecar for t3code.
//
// Newline-delimited JSON protocol over stdio (see
// apps/server/src/transcription/TranscriptionService.ts):
//
//   stdin:  {"type":"start","sessionId":"…","sampleRate":16000,"language":"es"}
//           {"type":"audio","sessionId":"…","pcm":"<base64 16-bit LE mono PCM>"}
//           {"type":"stop","sessionId":"…"}
//   stdout: {"type":"ready"}
//           {"type":"partial","sessionId":"…","segmentId":0,"text":"…"}
//           {"type":"final","sessionId":"…","segmentId":0,"text":"…"}
//           {"type":"ended","sessionId":"…"}
//           {"type":"error","sessionId":"…","message":"…"}
//
// Engine: NVIDIA Parakeet TDT 0.6b v3 (multilingual) via FluidAudio
// (Core ML / Neural Engine). Model weights are auto-downloaded from
// Hugging Face on first run (~600 MB, cached afterwards).
//
// Strategy: VAD-gated chunked inference. Audio is buffered per session;
// every PARTIAL_INTERVAL we re-transcribe the current segment window and
// emit a partial. A run of silence (energy VAD) or an explicit stop
// finalizes the segment.

import Foundation
import FluidAudio

// MARK: - Protocol types

struct InboundMessage: Decodable {
    let type: String
    let sessionId: String?
    let sampleRate: Int?
    let language: String?
    let pcm: String?
}

struct OutboundMessage: Encodable {
    let type: String
    var sessionId: String? = nil
    var segmentId: Int? = nil
    var text: String? = nil
    var message: String? = nil
}

let stdoutLock = NSLock()
func emit(_ message: OutboundMessage) {
    guard let data = try? JSONEncoder().encode(message),
          let line = String(data: data, encoding: .utf8)
    else { return }
    stdoutLock.lock()
    print(line)
    fflush(stdout)
    stdoutLock.unlock()
}

// MARK: - Tuning

let PARTIAL_INTERVAL: TimeInterval = 1.2
/// RMS below this counts as silence (post-AGC browser audio is fairly hot).
let SILENCE_RMS: Float = 0.012
/// Seconds of continuous silence that finalize the current segment.
let SILENCE_TO_FINALIZE: TimeInterval = 0.9
/// Hard cap per segment so the sliding window stays cheap (seconds).
let MAX_SEGMENT_SECONDS: Double = 60

// MARK: - Session state

final class Session {
    let id: String
    /// Optional language hint (script-aware token filtering in TDT v3).
    var language: Language?
    var segmentId: Int = 0
    /// 16 kHz mono samples of the in-flight segment.
    var buffer: [Float] = []
    var samplesAtLastInference: Int = 0
    var lastInferenceAt: Date = .distantPast
    var trailingSilence: TimeInterval = 0
    var lastPartialText: String = ""

    init(id: String) { self.id = id }
}

// MARK: - Engine actor

actor Engine {
    private var asrManager: AsrManager?
    private var sessions: [String: Session] = [:]

    func initialize() async {
        do {
            let models = try await AsrModels.downloadAndLoad()
            asrManager = AsrManager(config: .default, models: models)
            emit(OutboundMessage(type: "ready"))
        } catch {
            emit(OutboundMessage(type: "error", message: "model load failed: \(error)"))
            exit(1)
        }
    }

    func start(sessionId: String, language: String?) {
        let session = Session(id: sessionId)
        if let language {
            session.language = Language(rawValue: language)
        }
        sessions[sessionId] = session
    }

    func appendAudio(sessionId: String, samples: [Float]) async {
        guard let session = sessions[sessionId] else { return }
        session.buffer.append(contentsOf: samples)

        // Energy VAD over the appended chunk.
        let rms = sqrt(samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(max(samples.count, 1)))
        let chunkSeconds = Double(samples.count) / 16_000
        if rms < SILENCE_RMS {
            session.trailingSilence += chunkSeconds
        } else {
            session.trailingSilence = 0
        }

        let hasSpeech = session.buffer.count > Int(0.3 * 16_000)
        if hasSpeech, session.trailingSilence >= SILENCE_TO_FINALIZE {
            await finalizeSegment(session)
            return
        }
        if Double(session.buffer.count) / 16_000 >= MAX_SEGMENT_SECONDS {
            await finalizeSegment(session)
            return
        }
        if hasSpeech,
           Date().timeIntervalSince(session.lastInferenceAt) >= PARTIAL_INTERVAL,
           session.buffer.count > session.samplesAtLastInference
        {
            session.lastInferenceAt = Date()
            session.samplesAtLastInference = session.buffer.count
            if let text = await transcribe(session.buffer, session: session),
               !text.isEmpty, text != session.lastPartialText
            {
                session.lastPartialText = text
                emit(OutboundMessage(
                    type: "partial", sessionId: session.id, segmentId: session.segmentId,
                    text: text))
            }
        }
    }

    func stop(sessionId: String) async {
        guard let session = sessions[sessionId] else { return }
        await finalizeSegment(session)
        sessions.removeValue(forKey: sessionId)
        emit(OutboundMessage(type: "ended", sessionId: sessionId))
    }

    private func finalizeSegment(_ session: Session) async {
        defer {
            session.buffer.removeAll(keepingCapacity: true)
            session.samplesAtLastInference = 0
            session.trailingSilence = 0
            session.lastPartialText = ""
            session.lastInferenceAt = .distantPast
        }
        guard session.buffer.count > Int(0.3 * 16_000) else { return }
        if let text = await transcribe(session.buffer, session: session), !text.isEmpty {
            emit(OutboundMessage(
                type: "final", sessionId: session.id, segmentId: session.segmentId, text: text))
            session.segmentId += 1
        }
    }

    private func transcribe(_ samples: [Float], session: Session) async -> String? {
        guard let asrManager else { return nil }
        do {
            // The whole in-flight segment is re-transcribed each time, so each
            // call starts from a fresh decoder state.
            var decoderState = TdtDecoderState.make()
            let result = try await asrManager.transcribe(
                samples, decoderState: &decoderState, language: session.language)
            return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            emit(OutboundMessage(
                type: "error", sessionId: session.id, message: "transcription failed: \(error)"))
            return nil
        }
    }
}

// MARK: - PCM decoding

func decodePcm16(_ base64: String) -> [Float]? {
    guard let data = Data(base64Encoded: base64) else { return nil }
    let count = data.count / 2
    var samples = [Float](repeating: 0, count: count)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let int16Buffer = raw.bindMemory(to: Int16.self)
        for i in 0..<count {
            samples[i] = Float(Int16(littleEndian: int16Buffer[i])) / 32_768
        }
    }
    return samples
}

// MARK: - Main loop

let engine = Engine()

await engine.initialize()

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let message = try? JSONDecoder().decode(InboundMessage.self, from: data)
    else { continue }

    switch message.type {
    case "start":
        if let sessionId = message.sessionId {
            await engine.start(sessionId: sessionId, language: message.language)
        }
    case "audio":
        if let sessionId = message.sessionId,
           let pcm = message.pcm,
           let samples = decodePcm16(pcm)
        {
            await engine.appendAudio(sessionId: sessionId, samples: samples)
        }
    case "stop":
        if let sessionId = message.sessionId {
            await engine.stop(sessionId: sessionId)
        }
    default:
        continue
    }
}
