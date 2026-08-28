import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, hashJson, sha256 } from "../control/canonical.js";
import { isRecord, parseCommandEvidence } from "../control/model.js";
import { GENESIS_HASH } from "../control/store.js";
export function signedEventHashInput(event) {
    return canonicalJson(event);
}
export function parseAuthorityMetadata(input) {
    if (!isRecord(input) || input.schemaVersion !== 1) {
        throw new Error("Unsupported authority metadata schema");
    }
    const metadata = {
        schemaVersion: 1,
        authorityId: requireString(input, "authorityId"),
        publicKey: requireString(input, "publicKey"),
        missionId: requireString(input, "missionId"),
        contractHash: requireString(input, "contractHash"),
        graphHash: requireString(input, "graphHash"),
        createdAt: requireString(input, "createdAt"),
    };
    if (sha256(Buffer.from(metadata.publicKey, "base64")) !== metadata.authorityId) {
        throw new Error("Authority id does not match public key");
    }
    return metadata;
}
export function parseSignedEvidence(input) {
    if (!isRecord(input)) {
        throw new Error("Signed evidence must be an object");
    }
    assertExactKeys(input, [
        "sequence",
        "timestamp",
        "eventType",
        "taskId",
        "checkId",
        "contractHash",
        "graphHash",
        "inputHashBefore",
        "inputHashAfter",
        "stableInputs",
        "command",
        "result",
        "previousHash",
        "entryHash",
        "authorityId",
        "signature",
    ], "signed evidence");
    if (!isRecord(input.command) || !isRecord(input.result)) {
        throw new Error("Signed evidence command and result must be objects");
    }
    assertExactKeys(input.command, ["program", "args", "cwd"], "signed command");
    assertExactKeys(input.result, ["exitCode", "stdoutHash", "stderrHash"], "signed result");
    const signature = requireString(input, "signature");
    const authorityId = requireString(input, "authorityId");
    const { signature: ignoredSignature, authorityId: ignoredAuthority, ...base } = input;
    void ignoredSignature;
    void ignoredAuthority;
    return {
        ...parseCommandEvidence(base),
        authorityId,
        signature,
    };
}
export function verifySignedLedger(stateDir, expectedAuthorityId, pinnedHead) {
    const errors = [];
    const events = [];
    let metadata;
    let previousHash = GENESIS_HASH;
    try {
        metadata = parseAuthorityMetadata(readJson(join(stateDir, "authority.json")));
        if (metadata.authorityId !== expectedAuthorityId) {
            errors.push("Authority id does not match the pinned identity");
        }
        const frozenMission = readJson(join(stateDir, "mission.json"));
        const frozenGraph = readJson(join(stateDir, "task-graph.json"));
        if (hashJson(frozenMission) !== metadata.contractHash) {
            errors.push("Frozen mission hash does not match authority metadata");
        }
        if (hashJson(frozenGraph) !== metadata.graphHash) {
            errors.push("Frozen graph hash does not match authority metadata");
        }
    }
    catch (error) {
        errors.push(`Invalid authority metadata: ${messageOf(error)}`);
    }
    const ledgerPath = join(stateDir, "ledger.jsonl");
    const lines = existsSync(ledgerPath)
        ? readFileSync(ledgerPath, "utf8").split(/\r?\n/u).filter((line) => line.length > 0)
        : [];
    for (let index = 0; index < lines.length; index += 1) {
        try {
            const event = parseSignedEvidence(JSON.parse(lines[index]));
            const expectedSequence = index + 1;
            if (event.sequence !== expectedSequence) {
                errors.push(`Sequence mismatch at line ${expectedSequence}`);
            }
            if (event.previousHash !== previousHash) {
                errors.push(`Previous hash mismatch at line ${expectedSequence}`);
            }
            if (metadata && event.authorityId !== metadata.authorityId) {
                errors.push(`Authority mismatch at line ${expectedSequence}`);
            }
            if (metadata &&
                (event.contractHash !== metadata.contractHash || event.graphHash !== metadata.graphHash)) {
                errors.push(`Frozen contract or graph mismatch at line ${expectedSequence}`);
            }
            const { entryHash, signature, ...unsigned } = event;
            const expectedHash = sha256(signedEventHashInput(unsigned));
            if (entryHash !== expectedHash) {
                errors.push(`Entry hash mismatch at line ${expectedSequence}`);
            }
            if (metadata) {
                const publicKey = createPublicKey({
                    key: Buffer.from(metadata.publicKey, "base64"),
                    format: "der",
                    type: "spki",
                });
                if (!verify(null, Buffer.from(entryHash, "hex"), publicKey, Buffer.from(signature, "base64"))) {
                    errors.push(`Invalid signature at line ${expectedSequence}`);
                }
            }
            if (!logsMatch(stateDir, event)) {
                errors.push(`Evidence logs mismatch at line ${expectedSequence}`);
            }
            previousHash = entryHash;
            events.push(event);
        }
        catch (error) {
            errors.push(`Invalid ledger line ${index + 1}: ${messageOf(error)}`);
        }
    }
    const computedHead = { entries: events.length, headHash: previousHash };
    try {
        const storedHead = parseHead(readJson(join(stateDir, "head.json")));
        if (storedHead.entries !== computedHead.entries ||
            storedHead.headHash !== computedHead.headHash) {
            errors.push("Stored head does not match signed ledger contents");
        }
    }
    catch (error) {
        errors.push(`Invalid authority head: ${messageOf(error)}`);
    }
    if (pinnedHead) {
        if (pinnedHead.authorityId !== expectedAuthorityId) {
            errors.push("Pinned head belongs to another authority");
        }
        if (computedHead.entries < pinnedHead.entries ||
            (computedHead.entries === pinnedHead.entries &&
                computedHead.headHash !== pinnedHead.headHash)) {
            errors.push("Ledger rollback detected against pinned head");
        }
    }
    return { valid: errors.length === 0, errors, metadata, events, head: computedHead };
}
function logsMatch(stateDir, event) {
    const prefix = `${String(event.sequence).padStart(4, "0")}-${event.entryHash}`;
    const stdout = join(stateDir, "evidence", `${prefix}.stdout.log`);
    const stderr = join(stateDir, "evidence", `${prefix}.stderr.log`);
    return (existsSync(stdout) &&
        existsSync(stderr) &&
        sha256(readFileSync(stdout)) === event.result.stdoutHash &&
        sha256(readFileSync(stderr)) === event.result.stderrHash);
}
function parseHead(input) {
    if (!isRecord(input) ||
        !Number.isInteger(input.entries) ||
        typeof input.headHash !== "string") {
        throw new Error("Malformed head");
    }
    return { entries: Number(input.entries), headHash: input.headHash };
}
function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
function requireString(input, key) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Expected non-empty ${key}`);
    }
    return value;
}
function assertExactKeys(input, expected, context) {
    const expectedSet = new Set(expected);
    const unexpected = Object.keys(input).filter((key) => !expectedSet.has(key));
    const missing = expected.filter((key) => !(key in input));
    if (unexpected.length > 0 || missing.length > 0) {
        throw new Error(`${context} keys mismatch; missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}].`);
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
