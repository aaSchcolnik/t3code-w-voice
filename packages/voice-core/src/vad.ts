export const SILENCE_RMS = 0.012;
export const PARTIAL_INTERVAL_SECONDS = 1.2;
export const SILENCE_TO_FINALIZE_SECONDS = 0.9;
export const MAX_SEGMENT_SECONDS = 60;

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export interface EnergyVadOptions {
  readonly threshold?: number;
  /** Consecutive quiet seconds required before a speech segment is finalizable. */
  readonly hangoverSeconds?: number;
}

export interface VadObservation {
  readonly energy: number;
  readonly isSpeech: boolean;
  readonly trailingSilenceSeconds: number;
  readonly hasSpeech: boolean;
  readonly shouldFinalize: boolean;
}

/**
 * Small stateful energy VAD. It deliberately owns no clock: callers supply frame
 * duration so native implementations can replay the same conformance vectors.
 */
export class EnergyVad {
  readonly threshold: number;
  readonly hangoverSeconds: number;
  #hasSpeech = false;
  #trailingSilenceSeconds = 0;

  constructor(options: EnergyVadOptions = {}) {
    this.threshold = options.threshold ?? SILENCE_RMS;
    this.hangoverSeconds = options.hangoverSeconds ?? SILENCE_TO_FINALIZE_SECONDS;
  }

  observe(samples: Float32Array, durationSeconds: number): VadObservation {
    const energy = rms(samples);
    const isSpeech = energy >= this.threshold;
    if (isSpeech) {
      this.#hasSpeech = true;
      this.#trailingSilenceSeconds = 0;
    } else if (this.#hasSpeech) {
      this.#trailingSilenceSeconds += Math.max(0, durationSeconds);
    }
    return {
      energy,
      isSpeech,
      hasSpeech: this.#hasSpeech,
      trailingSilenceSeconds: this.#trailingSilenceSeconds,
      shouldFinalize: this.#hasSpeech && this.#trailingSilenceSeconds >= this.hangoverSeconds,
    };
  }

  reset(): void {
    this.#hasSpeech = false;
    this.#trailingSilenceSeconds = 0;
  }
}
