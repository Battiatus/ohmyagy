import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  GENESIS_HASH,
  calculateEventHash,
  verifyHashChain,
  type HashChainedEvent,
} from "./hash-chain.js";
import { isRecord } from "./canonical.js";

export class JournalStoreError extends Error {
  constructor(
    public readonly code: "IO_ERROR" | "INTEGRITY_ERROR" | "CORRUPT_TAIL" | "LOCK_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "JournalStoreError";
  }
}

export class JournalStore {
  private headHash: string = GENESIS_HASH;
  private headSequence: number = 0;

  constructor(public readonly filePath: string) {
    this.ensureInitialized();
  }

  private ensureInitialized(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", "utf8");
    } else {
      this.refreshHead();
    }
  }

  public getHead(): { sequence: number; hash: string } {
    return {
      sequence: this.headSequence,
      hash: this.headHash,
    };
  }

  public appendEvent<T extends Record<string, unknown>>(
    eventPayload: T,
  ): T & HashChainedEvent {
    const nextSequence = this.headSequence + 1;
    const parentHash = this.headHash;

    const baseEvent = {
      ...eventPayload,
      sequenceNumber: nextSequence,
      parentHash,
    };

    const eventHash = calculateEventHash(parentHash, baseEvent);
    const chainedEvent: T & HashChainedEvent = {
      ...baseEvent,
      eventHash,
    };

    const line = JSON.stringify(chainedEvent) + "\n";
    try {
      appendFileSync(this.filePath, line, { encoding: "utf8", flush: true });
    } catch (err) {
      throw new JournalStoreError(
        "IO_ERROR",
        `Failed to append to journal at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.headSequence = nextSequence;
    this.headHash = eventHash;

    return chainedEvent;
  }

  public readEvents(): HashChainedEvent[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const content = readFileSync(this.filePath, "utf8");
    if (!content.trim()) {
      return [];
    }

    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const events: HashChainedEvent[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const parsed = JSON.parse(line);
        if (!isRecord(parsed)) {
          throw new Error("Journal entry is not an object");
        }
        if (
          typeof parsed.sequenceNumber !== "number" ||
          typeof parsed.parentHash !== "string" ||
          typeof parsed.eventHash !== "string"
        ) {
          throw new Error("Missing required hash chain fields");
        }
        events.push(parsed as HashChainedEvent);
      } catch (err) {
        throw new JournalStoreError(
          "CORRUPT_TAIL",
          `Corrupt entry in journal at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return events;
  }

  public verifyIntegrity(): { valid: boolean; error?: string } {
    const events = this.readEvents();
    const result = verifyHashChain(events);
    if (!result.valid) {
      return {
        valid: false,
        error: result.errorReason,
      };
    }
    return { valid: true };
  }

  private refreshHead(): void {
    const events = this.readEvents();
    if (events.length === 0) {
      this.headHash = GENESIS_HASH;
      this.headSequence = 0;
      return;
    }

    const verification = verifyHashChain(events);
    if (!verification.valid) {
      throw new JournalStoreError(
        "INTEGRITY_ERROR",
        `Journal integrity verification failed: ${verification.errorReason}`,
      );
    }

    const lastEvent = events[events.length - 1];
    this.headSequence = lastEvent.sequenceNumber;
    this.headHash = lastEvent.eventHash;
  }
}
