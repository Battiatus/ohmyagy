import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { BrainStore } from "./brain-store.js";
import { listWorkspaceFiles } from "../broker/workspace-snapshot.js";

/**
 * Build the project model from the workspace itself.
 *
 * Components learned from dispatch evidence only exist for a project somebody has already
 * explored, which is backwards: the model is most useful *before* the first mission. The survey
 * walks the tree once, records every source file as an area, and derives `imports` relations from
 * the import statements it actually finds.
 *
 * Deliberately conservative:
 *
 *  * only source extensions become components — an inventory of images and lock files is noise;
 *  * only specifiers that resolve to **another file in the workspace** become relations. A bare
 *    package name is a dependency of the project, not a link between two of its areas, and
 *    guessing a mapping from `"lodash"` to a path would be inventing structure.
 */

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".java",
  ".cs",
  ".kt",
  ".swift",
] as const;

/** Extensions tried when resolving a specifier to a file, in order. */
const RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".java",
  ".cs",
  ".kt",
  ".swift",
] as const;

const IMPORT_PATTERNS: readonly RegExp[] = [
  // import x from 'y' / import { a } from "y" / export … from 'y' / import 'y'
  /(?:^|[\s;])import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
  /(?:^|[\s;])export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/gu,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /^\s*from\s+([.\w]+)\s+import\s/gmu,
  /^\s*import\s+([.\w]+)/gmu,
];

export interface SurveyOptions {
  workspaceRoot: string;
  brain: BrainStore;
  projectId: string;
  maxFiles?: number;
}

export interface SurveyResult {
  status: "surveyed";
  projectId: string;
  filesInspected: number;
  componentsRecorded: number;
  /** Sighting count, not new rows: a relation seen twice is one row with `mentions` 2. */
  relationsRecorded: number;
  /** Specifiers that name something outside the workspace, counted rather than linked. */
  externalSpecifiers: number;
  problems: string[];
}

export function surveyWorkspace(options: SurveyOptions): SurveyResult {
  const maxFiles = options.maxFiles ?? 2_000;
  const files = listWorkspaceFiles(options.workspaceRoot, { maxFiles });
  const fileSet = new Set(files);
  const problems: string[] = [];
  let componentsRecorded = 0;
  let relationsRecorded = 0;
  let externalSpecifiers = 0;
  const relations = new Set<string>();

  for (const path of files) {
    if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) continue;
    try {
      options.brain.recordComponent({
        projectId: options.projectId,
        path,
        kind: kindOf(path),
        source: "survey",
        summary: null,
      });
      componentsRecorded += 1;
    } catch (error) {
      problems.push(`${path}: ${messageOf(error)}`);
      continue;
    }

    let text: string;
    try {
      text = readFileSync(join(options.workspaceRoot, ...path.split("/")), "utf8");
    } catch (error) {
      problems.push(`${path}: ${messageOf(error)}`);
      continue;
    }

    for (const specifier of extractSpecifiers(text)) {
      const target = resolveSpecifier(path, specifier, fileSet);
      if (target === undefined) {
        if (isRelative(specifier)) problems.push(`${path}: '${specifier}' does not resolve to a workspace file`);
        else externalSpecifiers += 1;
        continue;
      }
      if (target === path) continue;
      const key = `${path}->${target}`;
      if (relations.has(key)) continue;
      relations.add(key);
      try {
        options.brain.recordRelation({
          projectId: options.projectId,
          fromPath: path,
          toPath: target,
          kind: "imports",
          source: "survey",
        });
        relationsRecorded += 1;
      } catch (error) {
        problems.push(`${key}: ${messageOf(error)}`);
      }
    }
  }

  return {
    status: "surveyed",
    projectId: options.projectId,
    filesInspected: files.length,
    componentsRecorded,
    relationsRecorded,
    externalSpecifiers,
    problems,
  };
}

function kindOf(path: string): string {
  const extension = path.slice(path.lastIndexOf("."));
  if ([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    return "source:javascript";
  }
  if (extension === ".py") return "source:python";
  return `source:${extension.replace(/^\./u, "")}`;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function extractSpecifiers(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    // Patterns are global; reset so a shared regex does not carry lastIndex between files.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const specifier = match[1]?.trim();
      if (specifier !== undefined && specifier.length > 0) found.add(specifier);
    }
  }
  return [...found];
}

/**
 * Resolve a specifier to a workspace file, or undefined.
 *
 * Returns undefined for anything that is not a relative path inside the workspace: an external
 * package, an absolute path, a builtin.
 */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | undefined {
  if (!isRelative(specifier)) {
    // A Python module path such as `pkg.mod` is only a project link if that file exists.
    const candidate = `${specifier.split(".").join("/")}.py`;
    return fileSet.has(candidate) ? candidate : undefined;
  }

  const fromDirectory = posix.dirname(fromPath);

  if (specifier.startsWith(".")) {
    // Python relative imports carry one dot per level, with no separator before the module.
    const pythonLevels = specifier.match(/^\.+/u)?.[0].length ?? 0;
    if (pythonLevels > 0 && !specifier.startsWith("./") && !specifier.startsWith("../")) {
      let base = fromDirectory;
      for (let level = 1; level < pythonLevels; level += 1) base = posix.dirname(base);
      const module = specifier.slice(pythonLevels).split(".").join("/");
      return firstExisting([posix.join(base, module)], fileSet) ??
        firstExisting([posix.join(base, module, "__init__")], fileSet);
    }
  }

  const base = posix.normalize(posix.join(fromDirectory, specifier));
  if (base.startsWith("..")) return undefined;
  const stripped = base.replace(/\.[A-Za-z0-9]+$/u, "");
  return (
    firstExisting([base], fileSet) ??
    firstExisting([stripped], fileSet) ??
    firstExisting([posix.join(base, "index")], fileSet) ??
    firstExisting([posix.join(stripped, "index")], fileSet) ??
    firstExisting([posix.join(base, "__init__")], fileSet)
  );
}

function firstExisting(bases: readonly string[], fileSet: ReadonlySet<string>): string | undefined {
  for (const base of bases) {
    for (const extension of RESOLUTION_EXTENSIONS) {
      if (fileSet.has(`${base}${extension}`)) return `${base}${extension}`;
    }
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Directory of a workspace-relative path, exported for callers that resolve siblings. */
export function workspaceDirectoryOf(path: string): string {
  return posix.dirname(path);
}

/** The absolute path of a workspace-relative file, for readers. */
export function workspaceAbsolutePath(workspaceRoot: string, path: string): string {
  return join(workspaceRoot, ...path.split("/"));
}

/** Parent directory of a workspace-relative path, as a POSIX path. */
export function parentOf(path: string): string {
  return dirname(path).split("\\").join("/");
}
