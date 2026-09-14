import assert from "node:assert/strict";
import { test } from "bun:test";
import { CapabilityResolver } from "../capability-resolver.js";
import {
  FALLBACK_MODEL_SLUGS,
  pickModelSlug,
  readModelCatalog,
  resetModelCatalogCache,
  resolveModelForClass,
} from "../model-catalog.js";

/**
 * The model table rotted silently once: `CapabilityResolver` hardcoded
 * `gemini-2.5-flash` / `gemini-3.7-flash` / `gemini-3.7-pro`, and AntiGravity 1.2.1 knows
 * none of them — every slug carries a tier suffix and the Pro line is `gemini-3.1-pro-*`.
 * Combined with a process runner that swallowed the child's error, every role dispatch
 * failed while reporting success.
 *
 * So the slugs are never asserted against a constant here. They are asserted against the
 * **installed build**, which is the only thing that can be right.
 */

const CATALOG = readModelCatalog();

test("no core expert resolves to a model the installed build does not offer", () => {
  if (CATALOG.source === "unavailable") {
    // Fail open but visibly: without the CLI this check cannot be made, and pretending
    // otherwise would be the same silence that let the table rot.
    console.warn("agy models unavailable; expert slugs were NOT verified against the build");
    return;
  }
  const resolved: string[] = [];
  for (const [name, spec] of Object.entries(CapabilityResolver.CORE_EXPERTS)) {
    const capability = CapabilityResolver.resolve(spec);
    resolved.push(`${name}=${capability.modelSlug}`);
    assert.ok(
      CATALOG.slugs.includes(capability.modelSlug),
      `expert '${name}' resolves to '${capability.modelSlug}', which agy does not offer. Installed: ${CATALOG.slugs.join(", ")}`,
    );
  }
  assert.ok(resolved.length >= 6, `expected at least the six vision roles, saw ${resolved.length}`);
});

test("the fallback slugs still exist in the installed build", () => {
  if (CATALOG.source === "unavailable") return;
  for (const [modelClass, slug] of Object.entries(FALLBACK_MODEL_SLUGS)) {
    assert.ok(
      CATALOG.slugs.includes(slug),
      `fallback for '${modelClass}' is '${slug}', which agy does not offer`,
    );
  }
});

test("a model class resolves to a slug the build offers, per class", () => {
  if (CATALOG.source === "unavailable") return;
  // No cache reset here: each re-read spawns `agy models`, and three of them exceed the
  // default test budget. The catalogue is a machine constant, not per-call state.
  const slugs = new Set<string>();
  for (const modelClass of ["fast", "balanced", "frontier"] as const) {
    const slug = resolveModelForClass(modelClass);
    assert.ok(CATALOG.slugs.includes(slug), `${modelClass} -> ${slug} is not offered by agy`);
    slugs.add(slug);
  }
  // The three classes must not collapse onto one slug: effort tiering is what makes the
  // role model (fast explorer vs frontier reviewer) mean anything.
  assert.equal(slugs.size, 3, `all classes resolved to ${[...slugs].join(", ")}`);
});

test("slug selection prefers the newest version and the requested tier", () => {
  const slugs = [
    "gemini-3.6-flash-low",
    "gemini-3.8-flash-low",
    "gemini-3.8-flash-high",
    "gemini-3.7-flash-medium",
    "gemini-3.1-pro-high",
    "claude-sonnet-4-6",
  ];
  assert.equal(pickModelSlug(slugs, { family: "flash", tier: "low" }), "gemini-3.8-flash-low");
  assert.equal(pickModelSlug(slugs, { family: "flash", tier: "high" }), "gemini-3.8-flash-high");
  assert.equal(pickModelSlug(slugs, { family: "flash", tier: "medium" }), "gemini-3.7-flash-medium");
  assert.equal(pickModelSlug(slugs, { family: "pro", tier: "high" }), "gemini-3.1-pro-high");
  assert.equal(pickModelSlug(slugs, { family: "flash", tier: "medium" }), "gemini-3.7-flash-medium");
  assert.equal(pickModelSlug(["claude-sonnet-4-6", "gpt-oss-120b-medium"], { family: "flash" }), undefined);
});

test("an explicit per-class override wins over the catalogue", () => {
  const previous = process.env.OMA_MODEL_BALANCED;
  process.env.OMA_MODEL_BALANCED = "my-own-model";
  resetModelCatalogCache();
  try {
    assert.equal(resolveModelForClass("balanced"), "my-own-model");
    assert.equal(CapabilityResolver.resolve("executor").modelSlug, "my-own-model");
  } finally {
    if (previous === undefined) {
      delete process.env.OMA_MODEL_BALANCED;
    } else {
      process.env.OMA_MODEL_BALANCED = previous;
    }
    resetModelCatalogCache();
  }
});
