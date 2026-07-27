import type { LocalTranscriptionCapabilities } from "@t3tools/contracts";
import type { Recognizer, RecognizerOptions, RecognizerResult } from "@t3tools/voice-core";
import { applyAsarTranscribeLibraryOverride } from "@t3tools/voice-core/transcribe-library";
import type {
  Capabilities,
  FamilyExtension,
  TranscribeModel,
  TranscribeOptions,
} from "transcribe-cpp";

interface LoadedBinding {
  readonly TranscribeModel: {
    load(path: string): Promise<TranscribeModel>;
  };
  readonly artifactDir?: () => string;
}

export type LoadTranscribeCppBinding = () => Promise<LoadedBinding>;

const loadDefaultBinding: LoadTranscribeCppBinding = async () => {
  const binding = await import("transcribe-cpp");
  applyAsarTranscribeLibraryOverride(binding);
  return binding;
};

const EMPTY_CAPABILITIES: LocalTranscriptionCapabilities = {
  languages: [],
  supportsLanguageDetect: false,
  supportsInitialPrompt: false,
  supportsStreaming: false,
};

const toCapabilities = (
  model: Pick<TranscribeModel, "capabilities" | "supports">,
): LocalTranscriptionCapabilities => {
  const capabilities: Capabilities = model.capabilities;
  return {
    languages: [...capabilities.languages],
    supportsLanguageDetect: capabilities.supportsLanguageDetect,
    supportsInitialPrompt: model.supports("initial_prompt"),
    supportsStreaming: capabilities.supportsStreaming,
  };
};

/**
 * Lazy adapter around the exact transcribe-cpp 0.1.3 API. Import and native
 * model load happen only inside the utility-process host.
 */
export class TranscribeCppRecognizer implements Recognizer {
  readonly #modelPath: string;
  readonly #loadBinding: LoadTranscribeCppBinding;
  #modelPromise: Promise<TranscribeModel> | undefined;
  #model: TranscribeModel | undefined;
  #capabilities: LocalTranscriptionCapabilities = EMPTY_CAPABILITIES;

  constructor(modelPath: string, loadBinding: LoadTranscribeCppBinding = loadDefaultBinding) {
    this.#modelPath = modelPath;
    this.#loadBinding = loadBinding;
  }

  get capabilities(): LocalTranscriptionCapabilities {
    return this.#capabilities;
  }

  async getCapabilities(): Promise<LocalTranscriptionCapabilities> {
    const model = await this.#loadModel();
    this.#capabilities = toCapabilities(model);
    return this.#capabilities;
  }

  async transcribe(pcm: Float32Array, options: RecognizerOptions): Promise<RecognizerResult> {
    const model = await this.#loadModel();
    const family = this.#resolvePromptFamily(model, options.promptHint);
    const transcribeOptions: TranscribeOptions = {
      timestamps: "none",
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(family === undefined ? {} : { family }),
    };
    const result = await model.transcribe(pcm, transcribeOptions);
    return { text: result.text };
  }

  dispose(): void {
    this.#model?.dispose();
    this.#model = undefined;
    this.#modelPromise = undefined;
    this.#capabilities = EMPTY_CAPABILITIES;
  }

  async #loadModel(): Promise<TranscribeModel> {
    if (this.#model !== undefined) return this.#model;
    this.#modelPromise ??= this.#loadBinding()
      .then((binding) => binding.TranscribeModel.load(this.#modelPath))
      .then((model) => {
        this.#model = model;
        this.#capabilities = toCapabilities(model);
        return model;
      })
      .catch((error) => {
        this.#modelPromise = undefined;
        throw error;
      });
    return this.#modelPromise;
  }

  #resolvePromptFamily(
    model: Pick<TranscribeModel, "accepts">,
    promptHint: string | undefined,
  ): FamilyExtension | undefined {
    const initialPrompt = promptHint?.trim();
    if (!initialPrompt || !model.accepts({ kind: "whisper" })) return undefined;
    return { kind: "whisper", initialPrompt };
  }
}
