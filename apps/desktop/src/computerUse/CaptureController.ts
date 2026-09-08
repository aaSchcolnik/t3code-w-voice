import type { ComputerUseCaptureStartInput } from "@t3tools/contracts";

export interface CaptureSource {
  sourceId: string;
  appName?: string;
  scope: "window" | "desktop";
}

export function makeCaptureController(dependencies: {
  now: () => number;
  createId: () => string;
  authorize: (input: ComputerUseCaptureStartInput) => Promise<boolean>;
  resolve: (input: ComputerUseCaptureStartInput) => Promise<CaptureSource>;
}) {
  const permissions = new Map<string, Promise<boolean>>();
  const captures = new Map<string, { senderId: number; armedUntil: number }>();
  const epochs = new Map<number, number>();
  return {
    async start(senderId: number, input: ComputerUseCaptureStartInput) {
      const epoch = epochs.get(senderId) ?? 0;
      const permissionKey = JSON.stringify([senderId, input.sessionId, input.target.kind]);
      let permission = permissions.get(permissionKey);
      if (!permission) {
        permission = dependencies.authorize(input);
        permissions.set(permissionKey, permission);
        if (permissions.size > 128) permissions.delete(permissions.keys().next().value!);
      }
      let allowed: boolean;
      try {
        allowed = await permission;
      } catch (error) {
        if (permissions.get(permissionKey) === permission) permissions.delete(permissionKey);
        throw error;
      }
      if (!allowed) {
        if (permissions.get(permissionKey) === permission) permissions.delete(permissionKey);
        throw new Error("Computer-use preview permission was declined.");
      }
      const source = await dependencies.resolve(input);
      if ((epochs.get(senderId) ?? 0) !== epoch) throw new Error("Preview renderer closed.");
      const captureId = dependencies.createId();
      captures.set(captureId, { senderId, armedUntil: dependencies.now() + 15_000 });
      return { captureId, ...source };
    },
    hasArm(senderId: number): boolean {
      return [...captures.values()].some(
        (capture) => capture.senderId === senderId && capture.armedUntil > dependencies.now(),
      );
    },
    consumeArm(senderId: number): boolean {
      for (const capture of captures.values()) {
        if (capture.senderId === senderId && capture.armedUntil > dependencies.now()) {
          capture.armedUntil = 0;
          return true;
        }
      }
      return false;
    },
    stop(senderId: number, captureId: string) {
      if (captures.get(captureId)?.senderId === senderId) captures.delete(captureId);
    },
    clearSender(senderId: number) {
      epochs.set(senderId, (epochs.get(senderId) ?? 0) + 1);
      for (const [id, capture] of captures) {
        if (capture.senderId === senderId) captures.delete(id);
      }
      for (const key of permissions.keys()) {
        if (key.startsWith(`[${senderId},`)) permissions.delete(key);
      }
    },
  };
}
