import assert from "node:assert/strict";
import test from "node:test";
import {
  BrokerRejection,
  contentHash,
  validateProposal,
  workspaceStateFromContents,
} from "../transaction.js";

function rejectionCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof BrokerRejection);
    return error.code;
  }
  assert.fail("Expected broker rejection");
}

test("derives a deterministic transaction id and next version", () => {
  const state = workspaceStateFromContents({ "src/a.ts": "old", "remove.txt": "gone" });
  const proposal = {
    schemaVersion: 1,
    parentVersion: state.version,
    operations: [
      {
        kind: "write",
        path: "src/a.ts",
        baseHash: contentHash("old"),
        content: "new",
      },
      {
        kind: "write",
        path: "src/b.ts",
        baseHash: null,
        content: "created",
      },
      {
        kind: "delete",
        path: "remove.txt",
        baseHash: contentHash("gone"),
      },
    ],
  };

  const first = validateProposal(state, proposal);
  const second = validateProposal(state, proposal);
  assert.equal(first.transactionId, second.transactionId);
  assert.equal(first.nextVersion, second.nextVersion);
  assert.match(first.transactionId, /^[a-f0-9]{64}$/);
  assert.notEqual(first.nextVersion, state.version);
});

test("rejects a stale parent version", () => {
  const state = workspaceStateFromContents({ "a.txt": "old" });
  assert.equal(
    rejectionCode(() =>
      validateProposal(state, {
        schemaVersion: 1,
        parentVersion: "stale-parent",
        operations: [
          {
            kind: "write",
            path: "a.txt",
            baseHash: contentHash("old"),
            content: "new",
          },
        ],
      }),
    ),
    "stale_parent",
  );
});

test("rejects stale per-file hashes and create-over-existing ambiguity", () => {
  const state = workspaceStateFromContents({ "a.txt": "old" });
  const baseProposal = {
    schemaVersion: 1,
    parentVersion: state.version,
  };
  assert.equal(
    rejectionCode(() =>
      validateProposal(state, {
        ...baseProposal,
        operations: [
          {
            kind: "write",
            path: "a.txt",
            baseHash: contentHash("different"),
            content: "new",
          },
        ],
      }),
    ),
    "stale_file",
  );
  assert.equal(
    rejectionCode(() =>
      validateProposal(state, {
        ...baseProposal,
        operations: [{ kind: "write", path: "a.txt", baseHash: null, content: "new" }],
      }),
    ),
    "existing_file",
  );
});

test("rejects traversal, absolute paths and Windows case collisions", () => {
  const state = workspaceStateFromContents({ "Src/A.ts": "old" });
  for (const path of ["../outside", "/absolute", "C:/drive", "dir\\file"] as const) {
    assert.equal(
      rejectionCode(() =>
        validateProposal(state, {
          schemaVersion: 1,
          parentVersion: state.version,
          operations: [{ kind: "write", path, baseHash: null, content: "x" }],
        }),
      ),
      "invalid_path",
      path,
    );
  }
  assert.equal(
    rejectionCode(() =>
      validateProposal(state, {
        schemaVersion: 1,
        parentVersion: state.version,
        operations: [{ kind: "write", path: "src/a.ts", baseHash: null, content: "x" }],
      }),
    ),
    "duplicate_path",
  );
});

test("rejects duplicate operations and hidden proposal fields", () => {
  const state = workspaceStateFromContents({});
  assert.equal(
    rejectionCode(() =>
      validateProposal(state, {
        schemaVersion: 1,
        parentVersion: state.version,
        operations: [
          { kind: "write", path: "a.txt", baseHash: null, content: "one" },
          { kind: "write", path: "A.txt", baseHash: null, content: "two" },
        ],
      }),
    ),
    "duplicate_path",
  );
  assert.equal(
    rejectionCode(() =>
      validateProposal(state, {
        schemaVersion: 1,
        parentVersion: state.version,
        operations: [{ kind: "write", path: "a.txt", baseHash: null, content: "x" }],
        verdict: "approved-by-agent",
      }),
    ),
    "malformed_proposal",
  );
});
