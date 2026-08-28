import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
export function canonicalJson(value) {
    return JSON.stringify(sortValue(value));
}
function sortValue(value) {
    if (Array.isArray(value)) {
        return value.map(sortValue);
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, sortValue(item)]));
    }
    return value;
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function hashJson(value) {
    return sha256(canonicalJson(value));
}
const ignoredSegments = new Set(["node_modules", "dist", ".git"]);
function normalizeRelative(path) {
    return path.replaceAll("\\", "/");
}
function shouldIgnore(relativePath) {
    const normalized = normalizeRelative(relativePath);
    const segments = normalized.split("/").filter(Boolean);
    if (segments.some((segment) => ignoredSegments.has(segment))) {
        return true;
    }
    return (normalized === ".oma/control/ledger.jsonl" ||
        normalized === ".oma/control/ledger.head.json" ||
        normalized.startsWith(".oma/control/evidence/") ||
        normalized === ".oma/control/control.lock" ||
        normalized === ".oma/graph/events.jsonl" ||
        normalized === ".oma/graph/head.json" ||
        normalized === ".oma/graph/graph.lock");
}
export function hashTrackedPaths(root, trackedPaths) {
    const entries = [];
    for (const trackedPath of [...trackedPaths].sort()) {
        const absolutePath = isAbsolute(trackedPath)
            ? resolve(trackedPath)
            : resolve(root, trackedPath);
        collectEntries(root, absolutePath, entries);
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return hashJson(entries);
}
function collectEntries(root, absolutePath, entries) {
    const relativePath = normalizeRelative(relative(root, absolutePath));
    if (shouldIgnore(relativePath)) {
        return;
    }
    if (!existsSync(absolutePath)) {
        entries.push({ path: relativePath, type: "missing" });
        return;
    }
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
        entries.push({
            path: relativePath,
            type: "symlink",
            target: readlinkSync(absolutePath),
        });
        return;
    }
    if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        for (const child of readdirSync(absolutePath).sort()) {
            collectEntries(root, join(absolutePath, child), entries);
        }
        return;
    }
    entries.push({
        path: relativePath,
        type: "file",
        hash: sha256(readFileSync(absolutePath)),
    });
}
