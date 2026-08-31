import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
export function resolveRepoPath(repositoryRoot, entry) {
    const root = realpathSync.native(repositoryRoot);
    if (entry.length === 0 ||
        entry.includes("\0") ||
        entry.includes("\\") ||
        entry.startsWith("/") ||
        /^[A-Za-z]:/u.test(entry) ||
        isAbsolute(entry)) {
        throw new Error(`Path escapes the repository root: ${entry}`);
    }
    const resolved = resolve(root, entry);
    const fromRoot = relative(root, resolved);
    assertContainedRelativePath(fromRoot, entry);
    let current = root;
    let deepestExisting = root;
    for (const segment of fromRoot.split(/[\\/]/u)) {
        current = join(current, segment);
        try {
            const stats = lstatSync(current);
            if (stats.isSymbolicLink()) {
                throw new Error(`Path crosses a symbolic link or junction: ${entry}`);
            }
            deepestExisting = current;
        }
        catch (error) {
            if (isMissingPathError(error))
                break;
            throw error;
        }
    }
    const realAncestor = realpathSync.native(deepestExisting);
    assertContainedRelativePath(relative(root, realAncestor), entry, true);
    return resolved;
}
function assertContainedRelativePath(fromRoot, entry, allowRoot = false) {
    const firstSegment = fromRoot.split(/[\\/]/u)[0];
    if ((!allowRoot && fromRoot.length === 0) ||
        isAbsolute(fromRoot) ||
        firstSegment === "..") {
        throw new Error(`Path escapes the repository root: ${entry}`);
    }
}
function isMissingPathError(error) {
    return (error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
