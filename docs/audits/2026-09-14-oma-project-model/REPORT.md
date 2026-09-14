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

## What "complete" still needs

- **Relations.** The model holds areas, not the links between them. Imports, ownership and
  dependency edges between components are not represented, so "what depends on this?" cannot be
  answered from the model.
- **A survey, not only a by-product.** Components are learned from dispatch evidence. A project
  nobody has dispatched into has an empty model; building the initial model from a
  workspace-wide pass is a separate feeder.
