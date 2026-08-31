import { canonicalJson, sha256 } from "./canonical.js";

export const GENESIS_HASH = "0".repeat(64);

export interface HashChainedEvent {
  sequenceNumber: number;
  parentHash: string;
  eventHash: string;
  [key: string]: unknown;
}

export function calculateEventHash(parentHash: string, eventData: Record<string, unknown>): string {
  // Strip out eventHash if present to calculate hash of payload + parentHash
  const { eventHash, ...payload } = eventData;
  const canonicalPayload = canonicalJson({
    parentHash,
    ...payload,
  });
  return sha256(canonicalPayload);
}

export function verifyHashChain(events: HashChainedEvent[]): {
  valid: boolean;
  errorIndex?: number;
  errorReason?: string;
} {
  let expectedParentHash = GENESIS_HASH;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.sequenceNumber !== i + 1) {
      return {
        valid: false,
        errorIndex: i,
        errorReason: `Sequence number mismatch at index ${i}: expected ${i + 1}, got ${event.sequenceNumber}`,
      };
    }
    if (event.parentHash !== expectedParentHash) {
      return {
        valid: false,
        errorIndex: i,
        errorReason: `Parent hash mismatch at index ${i}: expected ${expectedParentHash}, got ${event.parentHash}`,
      };
    }
    const computedHash = calculateEventHash(event.parentHash, event);
    if (event.eventHash !== computedHash) {
      return {
        valid: false,
        errorIndex: i,
        errorReason: `Event hash mismatch at index ${i}: expected ${computedHash}, got ${event.eventHash}`,
      };
    }
    expectedParentHash = event.eventHash;
  }

  return { valid: true };
}
