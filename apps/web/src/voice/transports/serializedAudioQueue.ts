const DEFAULT_MAX_PENDING_AUDIO_SENDS = 32;

/**
 * Serializes accepted audio writes for one transcription session.
 *
 * The queue is intentionally bounded: microphone capture must not accumulate
 * unbounded PCM when the transport is slower than realtime. Once stop begins,
 * callers close the queue and drain every accepted write before sending Stop.
 */
export function createSerializedAudioQueue(options?: {
  readonly maxPending?: number;
  readonly onError?: (cause: unknown) => void;
}) {
  const maxPending = options?.maxPending ?? DEFAULT_MAX_PENDING_AUDIO_SENDS;
  let tail = Promise.resolve();
  let pending = 0;
  let closed = false;
  let firstFailure: unknown;

  return {
    enqueue(operation: () => Promise<void>): boolean {
      if (closed || pending >= maxPending) return false;
      pending += 1;
      tail = tail
        .then(operation)
        .catch((cause: unknown) => {
          firstFailure ??= cause;
          options?.onError?.(cause);
        })
        .finally(() => {
          pending -= 1;
        });
      return true;
    },

    close() {
      closed = true;
    },

    async drain(): Promise<void> {
      closed = true;
      await tail;
      if (firstFailure !== undefined) throw firstFailure;
    },

    get pending() {
      return pending;
    },
  };
}
