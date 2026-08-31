import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import { MissionEventsStore, type SequencedMissionEvent } from "./mission-events.js";
import { MissionProjectionEngine, type FullMissionProjection } from "../graph/mission-projections.js";

export interface JournalCheckpoint {
  schemaVersion: number;
  missionId: string;
  checkpointTimestamp: string;
  totalEventsCompacted: number;
  lastEventDigest: string;
  cumulativeMerkleRoot: string;
  projectedState: FullMissionProjection;
  checkpointDigest: string;
}

export class JournalCompactionEngine {
  /**
   * Generates an integrity-preserving checkpoint from the event journal.
   */
  public static createCheckpoint(eventsPath: string, checkpointPath: string): JournalCheckpoint {
    if (!existsSync(eventsPath)) {
      throw new Error(`Events log not found: ${eventsPath}`);
    }

    const events = MissionEventsStore.readEvents(eventsPath);
    if (events.length === 0) {
      throw new Error(`Cannot compact empty event log: ${eventsPath}`);
    }

    const missionId = events[0].missionId;
    const lastEvent = events[events.length - 1];
    const projectedState = MissionProjectionEngine.project(events);

    // Compute cumulative Merkle-style root over all event digests
    const cumulativeMerkleRoot = sha256(
      events.map((e) => `${e.seq}:${e.eventHash}`).join("\n"),
    );

    const checkpointTimestamp = new Date().toISOString();

    const rawCheckpoint = {
      schemaVersion: 1,
      missionId,
      checkpointTimestamp,
      totalEventsCompacted: events.length,
      lastEventDigest: lastEvent.eventHash,
      cumulativeMerkleRoot,
      projectedState,
    };

    const checkpointDigest = sha256(canonicalJson(rawCheckpoint));

    const checkpoint: JournalCheckpoint = {
      ...rawCheckpoint,
      checkpointDigest,
    };

    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    return checkpoint;
  }

  /**
   * Verifies the cryptographic integrity of a checkpoint against raw events.
   */
  public static verifyCheckpoint(checkpoint: JournalCheckpoint, events: SequencedMissionEvent[]): boolean {
    const rawCheckpoint = {
      schemaVersion: checkpoint.schemaVersion,
      missionId: checkpoint.missionId,
      checkpointTimestamp: checkpoint.checkpointTimestamp,
      totalEventsCompacted: checkpoint.totalEventsCompacted,
      lastEventDigest: checkpoint.lastEventDigest,
      cumulativeMerkleRoot: checkpoint.cumulativeMerkleRoot,
      projectedState: checkpoint.projectedState,
    };

    const recomputedDigest = sha256(canonicalJson(rawCheckpoint));
    if (recomputedDigest !== checkpoint.checkpointDigest) {
      return false;
    }

    const expectedRoot = sha256(
      events.map((e) => `${e.seq}:${e.eventHash}`).join("\n"),
    );

    return expectedRoot === checkpoint.cumulativeMerkleRoot;
  }
}
