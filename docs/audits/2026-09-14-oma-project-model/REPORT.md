# 2026-09-14 — a durable project model, not just episodic memory

The vision asks for a complete and durable view of the project. What existed was episodic: the
Brain stores *what happened* — an architectural decision, a past error, a run summary, a user
preference — and the graph stores *one mission's* plan. Nothing stored the project's own shape,
so every mission rediscovered the same ground and the knowledge died with its graph.

## What was added

`project_components`, in the project's Brain:

```
id, project_id, path, kind, summary, source, mentions, first_seen_at, last_seen_at
UNIQUE(project_id, path)
```

An area of the project, how often exploration has touched it, and the most recent thing learned
about it. `recordComponent` upserts by path — a second look increments `mentions` instead of
duplicating the row — and `listComponents` returns the project's areas, most recently seen
first, strictly scoped to one project like every other Brain read.

## What feeds it, and what reads it

- **`dispatch_node`** records the paths an expert actually examined: an exploratory answer names
  its `evidence`, and those paths become components with the answer's `summary` as their latest
  knowledge, `source: dispatch:<expertId>`. A bookkeeping failure is returned in the dispatch
  result as `projectModelProblems` rather than swallowed — silently staying empty is how a
  project model rots.
- **`project_model`** is a new read-only Brain tool (26 tools now) returning the components,
  their mention counts and their latest summaries.

## Defect found by the tests

`bun:sqlite` returns **`null`** for a missing row where `node:sqlite` returns `undefined`, and
the adapter's signature promises `undefined`. The upsert's `existing === undefined` check
therefore took the update branch on the very first insert and threw on `existing.id`. Both read
sites now normalise to `undefined`. The Brain runs under both runtimes, so this class of
difference has to be normalised at the adapter boundary rather than assumed away.

## Verified

Tests pin: the areas an expert examined become components, a second mention increments instead of
duplicating, an area's summary is the most recent knowledge, and `project_model` never returns
another project's components.

`npm test`: **439 pass, 3 skip, 0 fail**, exit 0.

## Relations

`project_component_relations` holds `(project_id, from_path, to_path, kind, source, mentions)`,
upserted on `(from, to, kind)` like components are upserted on path. A list of areas answers "what
is in this project"; it cannot answer "what depends on this", and that is what a structural change
has to be checked against. `project_model` returns the links alongside the areas.

## The survey: a model before anyone has explored

Components learned from dispatch evidence only exist for a project somebody has already explored,
which is backwards. `project_survey` (27 tools now) walks the tree once, records every **source**
file as an area, and derives `imports` relations from the import statements it actually finds.

Deliberately conservative: only specifiers that **resolve to another file in the workspace**
become links. A bare package name is a dependency of the project, not a link between two of its
areas, and mapping `"lodash"` to a path would be inventing structure. A relative specifier that
does not resolve is reported rather than linked.

## Measured on real projects

`.oma/verify-project-model.mjs` surveys the OMA checkout and **Symap** — an aggregate of two
repositories with no `.git` at its root. Read-only: the model goes to a throwaway Brain.

```
=== OMA checkout ===
filesInspected: 774   components: 223   relations: 831   problems: 10
most depended-upon: src/ledger/canonical.ts (46), src/graph/model.ts (28),
                    src/ledger/mission-events.ts (24), src/graph/store.ts (24)

=== Symap (aggregate, no .git) ===
filesInspected: 1068  components: 446   relations: 59    problems: 0
most depended-upon: genai-image/frontend/src/contexts/AuthContext.js (13),
                    genai-image/frontend/src/services/secureTokenStorage.js (7),
                    genai-image/frontend/src/services/api.js (7)
```

## Defect the measurement found

The first run against Symap produced a model **dominated by
`genai-image/venv/Lib/site-packages/anthropic/…`** — 794 unresolved-specifier problems, all from a
virtualenv. Only `node_modules` and OMA's own directories were excluded, so a dependency tree, its
caches and its build outputs were treated as project. The same list governs the snapshot, so this
also meant every Git-free proposal's compare-and-swap hashed thousands of third-party files.

`DEFAULT_SNAPSHOT_EXCLUDES` now covers installed dependencies (`venv`, `.venv`, `site-packages`,
`vendor`), caches (`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `coverage`, …) and
build outputs (`dist`, `build`, `out`, `target`, `.next`, …). After the fix Symap's model is 446
areas and 59 real links with **zero** problems, built in under 4 seconds.

## Still open

- **Ownership and cross-area links.** The survey derives `imports`. Nothing derives which area owns
  which, or links that are not imports, so `kind` is exercised by one value only.
- **Coverage of other languages.** Import extraction covers JavaScript/TypeScript and Python
  module paths. Go, Rust, Ruby, Java, C# and the rest are recorded as areas but produce no links.
