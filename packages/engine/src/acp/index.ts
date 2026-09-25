/**
 * ACP (Agent Client Protocol) seam — adapter only, later (ADR-0002, protocol pin §6/§7).
 * M0 ships this stub: types + NotImplemented. The native path never speaks ACP.
 */

export class NotImplementedError extends Error {
  readonly feature: string;
  constructor(feature: string) {
    super(`${feature} is not implemented in M0`);
    this.name = "NotImplementedError";
    this.feature = feature;
  }
}

/** Placeholder shape for a future ACP ↔ MAD native adapter. */
export type AcpAdapter = {
  readonly protocol: "acp";
  /** Would translate one ACP message into MAD native protocol calls. */
  handle(message: unknown): Promise<unknown>;
};

export function createAcpAdapter(): AcpAdapter {
  throw new NotImplementedError("ACP adapter");
}
