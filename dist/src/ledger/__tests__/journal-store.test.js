import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JournalStore, JournalStoreError } from "../journal-store.js";
import { GENESIS_HASH } from "../hash-chain.js";
test("JournalStore appends events with valid SHA-256 hash chaining", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-journal-test-"));
    const journalPath = join(root, "events.jsonl");
    try {
        const store = new JournalStore(journalPath);
        assert.equal(store.getHead().sequence, 0);
        assert.equal(store.getHead().hash, GENESIS_HASH);
        const event1 = store.appendEvent({
            type: "mission_started",
            missionId: "mission_01",
        });
        assert.equal(event1.sequenceNumber, 1);
        assert.equal(event1.parentHash, GENESIS_HASH);
        assert.equal(typeof event1.eventHash, "string");
        assert.equal(event1.eventHash.length, 64);
        const event2 = store.appendEvent({
            type: "node_dispatched",
            nodeId: "node_01",
            dispatchId: "disp_01",
        });
        assert.equal(event2.sequenceNumber, 2);
        assert.equal(event2.parentHash, event1.eventHash);
        assert.equal(store.getHead().sequence, 2);
        assert.equal(store.getHead().hash, event2.eventHash);
        const events = store.readEvents();
        assert.equal(events.length, 2);
        const integrity = store.verifyIntegrity();
        assert.equal(integrity.valid, true);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("JournalStore recovers and verifies existing journal on re-open", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-journal-test-"));
    const journalPath = join(root, "events.jsonl");
    try {
        const store1 = new JournalStore(journalPath);
        const event1 = store1.appendEvent({ type: "event_1" });
        const event2 = store1.appendEvent({ type: "event_2" });
        // Open second instance pointing to same file
        const store2 = new JournalStore(journalPath);
        assert.equal(store2.getHead().sequence, 2);
        assert.equal(store2.getHead().hash, event2.eventHash);
        const event3 = store2.appendEvent({ type: "event_3" });
        assert.equal(event3.sequenceNumber, 3);
        assert.equal(event3.parentHash, event2.eventHash);
        const allEvents = store2.readEvents();
        assert.equal(allEvents.length, 3);
        assert.equal(store2.verifyIntegrity().valid, true);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("JournalStore detects tampering of event payload", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-journal-test-"));
    const journalPath = join(root, "events.jsonl");
    try {
        const store = new JournalStore(journalPath);
        store.appendEvent({ type: "event_1", data: "original" });
        store.appendEvent({ type: "event_2" });
        // Tamper with the first event in the file
        const events = store.readEvents();
        events[0].data = "tampered";
        writeFileSync(journalPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
        assert.throws(() => new JournalStore(journalPath), (err) => err instanceof JournalStoreError &&
            err.code === "INTEGRITY_ERROR" &&
            /Event hash mismatch/i.test(err.message));
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("JournalStore detects truncation or corrupted lines", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-journal-test-"));
    const journalPath = join(root, "events.jsonl");
    try {
        const store = new JournalStore(journalPath);
        store.appendEvent({ type: "event_1" });
        // Write a corrupted partial line
        writeFileSync(journalPath, '{"type": "corrupt_line", incomplete\n', { flag: "a" });
        assert.throws(() => new JournalStore(journalPath).readEvents(), JournalStoreError);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
