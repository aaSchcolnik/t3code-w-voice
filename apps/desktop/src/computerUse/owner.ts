import * as NodeCrypto from "node:crypto";

// Shared only between Electron main and its local backend. Never persisted or
// forwarded to SSH/WSL environments, which do not own this graphical session.
export const computerUseCaptureOwnerToken = NodeCrypto.randomBytes(32).toString("hex");
