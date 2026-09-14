import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { BrainStore } from "../brain-store.js";
import { resolveSpecifier, surveyWorkspace } from "../project-survey.js";

/**
 * The project model has to exist *before* anyone explores, otherwise it is only a record of past
 * work. The survey builds it from the workspace: every source file becomes an area, and the
 * imports that link them become relations.
 *
 * It is deliberately conservative — only specifiers resolving to another workspace file become
 * links, because a bare package name is a dependency of the project, not a link between two of
 * its areas.
 */

let root: string;
let brain: BrainStore;

function write(relativePath: string, content: string): void {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oma-survey-"));
  brain = new BrainStore(join(root, ".oma", "brain.sqlite"));
});

afterEach(() => {
  brain.close();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(20);
    }
  }
});

describe("the survey builds the project model from the workspace", () => {
  it("records source files as areas and their internal imports as relations", () => {
    write("src/a.ts", "import { b } from './b';\nimport lodash from 'lodash';\nexport const a = b;\n");
    write("src/b.ts", "import './c';\nexport const b = 1;\n");
    write("src/c.ts", "export const c = 2;\n");
    write("README.md", "# not a source file\n");

    const project = brain.ensureProject({ name: "surveyed", rootPath: root });
    const result = surveyWorkspace({ workspaceRoot: root, brain, projectId: project.id });

    assert.equal(result.status, "surveyed");
    assert.equal(result.componentsRecorded, 3, "only source files are areas");
    assert.equal(result.relationsRecorded, 2, "a -> b and b -> c");
    assert.equal(result.externalSpecifiers, 1, "lodash is a dependency, not an internal link");
    assert.deepEqual(result.problems, []);

    const components = brain.listComponents({ projectId: project.id });
    assert.deepEqual(
      components.map((component) => component.path).sort(),
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    );
    assert.equal(components.every((component) => component.source === "survey"), true);

    const relations = brain.listRelations({ projectId: project.id });
    assert.deepEqual(
      relations.map((relation) => `${relation.fromPath}->${relation.toPath}`).sort(),
      ["src/a.ts->src/b.ts", "src/b.ts->src/c.ts"],
    );
    assert.equal(relations.every((relation) => relation.kind === "imports"), true);
  });

  it("resolves sibling, index and extensionless specifiers", () => {
    write("src/lib/index.ts", "export const lib = 1;\n");
    write("src/component.tsx", "export const Component = () => null;\n");
    write("src/entry.ts", [
      "import { lib } from './lib';",
      "import { Component } from './component';",
      "import './component.tsx';",
      "export const entry = [lib, Component];",
    ].join("\n"));

    const project = brain.ensureProject({ name: "resolved", rootPath: root });
    const result = surveyWorkspace({ workspaceRoot: root, brain, projectId: project.id });
    assert.equal(result.relationsRecorded, 2, "the two distinct targets, not three mentions");

    const relations = brain.listRelations({ projectId: project.id });
    assert.deepEqual(
      relations.map((relation) => relation.toPath).sort(),
      ["src/component.tsx", "src/lib/index.ts"],
    );
  });

  it("links a python module path only when the file exists", () => {
    write("pkg/__init__.py", "");
    write("pkg/mod.py", "def f():\n    return 1\n");
    write("pkg/user.py", "from pkg.mod import f\nimport os\n");

    const project = brain.ensureProject({ name: "python", rootPath: root });
    const result = surveyWorkspace({ workspaceRoot: root, brain, projectId: project.id });

    const relations = brain.listRelations({ projectId: project.id });
    assert.deepEqual(
      relations.map((relation) => `${relation.fromPath}->${relation.toPath}`),
      ["pkg/user.py->pkg/mod.py"],
    );
    assert.equal(result.externalSpecifiers >= 1, true, "os is external");
  });

  it("reports a relative specifier that does not resolve instead of inventing a link", () => {
    write("src/lonely.ts", "import { gone } from './missing';\nexport const x = gone;\n");

    const project = brain.ensureProject({ name: "broken", rootPath: root });
    const result = surveyWorkspace({ workspaceRoot: root, brain, projectId: project.id });
    assert.equal(result.relationsRecorded, 0);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /'\.\/missing' does not resolve/u);
  });

  it("counts a repeated relation once and increments nothing else", () => {
    write("src/a.ts", "import './b';\nimport './b';\nexport const a = 1;\n");
    write("src/b.ts", "export const b = 1;\n");
    const project = brain.ensureProject({ name: "dup", rootPath: root });

    const first = surveyWorkspace({ workspaceRoot: root, brain, projectId: project.id });
    assert.equal(first.relationsRecorded, 1, "the two identical import lines are one observation");

    // A second survey sees the same link again. `relationsRecorded` counts sightings, so it is 1
    // again — what must not grow is the number of rows.
    const second = surveyWorkspace({ workspaceRoot: root, brain, projectId: project.id });
    assert.equal(second.relationsRecorded, 1);
    const relations = brain.listRelations({ projectId: project.id });
    assert.equal(relations.length, 1, "a relation seen twice is the same relation");
    assert.equal(relations[0].mentions, 2, "and the sighting is counted");
  });
});

describe("specifier resolution", () => {
  const files = new Set(["src/b.ts", "src/lib/index.ts", "pkg/mod.py", "pkg/__init__.py"]);

  it("returns undefined for anything outside the workspace", () => {
    assert.equal(resolveSpecifier("src/a.ts", "lodash", files), undefined);
    assert.equal(resolveSpecifier("src/a.ts", "node:fs", files), undefined);
    assert.equal(resolveSpecifier("src/a.ts", "../../outside", files), undefined);
  });

  it("resolves the forms it claims to support", () => {
    assert.equal(resolveSpecifier("src/a.ts", "./b", files), "src/b.ts");
    assert.equal(resolveSpecifier("src/a.ts", "./b.ts", files), "src/b.ts");
    assert.equal(resolveSpecifier("src/a.ts", "./lib", files), "src/lib/index.ts");
    assert.equal(resolveSpecifier("pkg/user.py", "pkg.mod", files), "pkg/mod.py");
  });
});
