import { posix } from "node:path";
import { canonicalJson, hashJson, sha256 } from "../control/canonical.js";
import { isRecord } from "../control/model.js";
export class BrokerRejection extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "BrokerRejection";
    }
}
const sha256Pattern = /^[a-f0-9]{64}$/;
export function contentHash(content) {
    return sha256(content);
}
export function workspaceStateFromContents(contents, version) {
    const files = {};
    const caseFolded = new Map();
    for (const [rawPath, content] of Object.entries(contents).sort(([left], [right]) => left.localeCompare(right))) {
        const path = validateCanonicalPath(rawPath);
        assertNoCaseCollision(caseFolded, path, "workspace");
        files[path] = contentHash(content);
    }
    return {
        version: version ?? hashJson(files),
        files: Object.freeze(files),
    };
}
export function validateProposal(state, input) {
    const proposal = parseProposal(input);
    if (proposal.parentVersion !== state.version) {
        throw new BrokerRejection("stale_parent", `Parent version ${proposal.parentVersion} does not match current version ${state.version}.`);
    }
    const workspacePaths = new Map();
    for (const path of Object.keys(state.files)) {
        const canonicalPath = validateCanonicalPath(path);
        assertNoCaseCollision(workspacePaths, canonicalPath, "workspace");
    }
    const operationPaths = new Map();
    const nextFiles = { ...state.files };
    for (const operation of proposal.operations) {
        assertNoCaseCollision(operationPaths, operation.path, "proposal");
        const existingCasing = workspacePaths.get(operation.path.toLocaleLowerCase("en-US"));
        if (existingCasing && existingCasing !== operation.path) {
            throw new BrokerRejection("duplicate_path", `Path ${operation.path} collides with existing path ${existingCasing}.`);
        }
        const currentHash = state.files[operation.path];
        if (operation.kind === "write") {
            if (currentHash === undefined && operation.baseHash !== null) {
                throw new BrokerRejection("missing_file", `Cannot update missing file ${operation.path}.`);
            }
            if (currentHash !== undefined && operation.baseHash === null) {
                throw new BrokerRejection("existing_file", `Cannot create existing file ${operation.path}.`);
            }
            if (currentHash !== undefined && operation.baseHash !== currentHash) {
                throw new BrokerRejection("stale_file", `Base hash for ${operation.path} is stale.`);
            }
            nextFiles[operation.path] = contentHash(operation.content);
            continue;
        }
        if (currentHash === undefined) {
            throw new BrokerRejection("missing_file", `Cannot delete missing file ${operation.path}.`);
        }
        if (operation.baseHash !== currentHash) {
            throw new BrokerRejection("stale_file", `Base hash for ${operation.path} is stale.`);
        }
        delete nextFiles[operation.path];
    }
    const transactionBody = {
        schemaVersion: 1,
        parentVersion: proposal.parentVersion,
        operations: proposal.operations,
    };
    return {
        ...transactionBody,
        transactionId: sha256(canonicalJson(transactionBody)),
        nextVersion: hashJson(nextFiles),
    };
}
function parseProposal(input) {
    if (!isRecord(input)) {
        malformed("Proposal must be an object.");
    }
    assertExactKeys(input, ["schemaVersion", "parentVersion", "operations"], "proposal");
    if (input.schemaVersion !== 1) {
        malformed("Unsupported proposal schema version.");
    }
    if (typeof input.parentVersion !== "string" || input.parentVersion.length === 0) {
        malformed("Proposal requires a non-empty parentVersion.");
    }
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
        malformed("Proposal requires at least one operation.");
    }
    return {
        schemaVersion: 1,
        parentVersion: input.parentVersion,
        operations: input.operations.map(parseOperation),
    };
}
function parseOperation(input, index) {
    if (!isRecord(input)) {
        malformed(`Operation ${index} must be an object.`);
    }
    if (input.kind === "write") {
        assertExactKeys(input, ["kind", "path", "baseHash", "content"], `write operation ${index}`);
        const path = parsePath(input.path, index);
        const baseHash = parseNullableHash(input.baseHash, index);
        if (typeof input.content !== "string") {
            malformed(`Write operation ${index} requires string content.`);
        }
        return { kind: "write", path, baseHash, content: input.content };
    }
    if (input.kind === "delete") {
        assertExactKeys(input, ["kind", "path", "baseHash"], `delete operation ${index}`);
        const path = parsePath(input.path, index);
        const baseHash = parseHash(input.baseHash, index);
        return { kind: "delete", path, baseHash };
    }
    malformed(`Operation ${index} has unsupported kind.`);
}
function parsePath(input, index) {
    if (typeof input !== "string") {
        malformed(`Operation ${index} requires a string path.`);
    }
    return validateCanonicalPath(input);
}
function validateCanonicalPath(path) {
    const normalizedUnicode = path.normalize("NFC");
    const segments = path.split("/");
    if (path.length === 0 ||
        normalizedUnicode !== path ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.includes(":") ||
        posix.isAbsolute(path) ||
        posix.normalize(path) !== path ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
        throw new BrokerRejection("invalid_path", `Path is not canonical and relative: ${path}`);
    }
    return path;
}
function parseNullableHash(input, index) {
    if (input === null) {
        return null;
    }
    return parseHash(input, index);
}
function parseHash(input, index) {
    if (typeof input !== "string" || !sha256Pattern.test(input)) {
        malformed(`Operation ${index} requires a lowercase SHA-256 baseHash.`);
    }
    return input;
}
function assertNoCaseCollision(seen, path, source) {
    const key = path.toLocaleLowerCase("en-US");
    const existing = seen.get(key);
    if (existing) {
        throw new BrokerRejection("duplicate_path", `Path ${path} duplicates ${existing} in ${source}.`);
    }
    seen.set(key, path);
}
function assertExactKeys(input, expected, context) {
    const expectedSet = new Set(expected);
    const unexpected = Object.keys(input).filter((key) => !expectedSet.has(key));
    const missing = expected.filter((key) => !(key in input));
    if (unexpected.length > 0 || missing.length > 0) {
        malformed(`${context} keys mismatch; missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}].`);
    }
}
function malformed(message) {
    throw new BrokerRejection("malformed_proposal", message);
}
