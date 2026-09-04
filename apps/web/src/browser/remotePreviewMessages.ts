import type { RemotePreviewControlMessage, RemotePreviewMotionMessage } from "@t3tools/contracts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Input messages as the gesture and keyboard models produce them. The viewer
 * stamps the live `generation` (and, on the motion channel, the sequence) as it
 * sends, so a model can never emit a message against a stale source.
 */
export type RemotePreviewControlDraft = DistributiveOmit<RemotePreviewControlMessage, "generation">;

export type RemotePreviewMotionDraft = DistributiveOmit<
  RemotePreviewMotionMessage,
  "generation" | "sequence"
>;
