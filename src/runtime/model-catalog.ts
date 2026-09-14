import { spawnSync } from "node:child_process";
import { AgyDriver } from "./agy-driver.js";

/**
 * Which model slugs the installed AntiGravity build actually offers.
 *
 * This module exists because the model names rotted silently. `CapabilityResolver`
 * hardcoded `gemini-2.5-flash` (fast), `gemini-3.7-flash` (balanced) and `gemini-3.7-pro`
 * (frontier); the 1.2.1 build knows none of them — every slug carries a tier suffix
 * (`gemini-3.7-flash-high`) and the Pro line is `gemini-3.1-pro-*`. Combined with the
 * process-runner defect that swallowed the child's error, this meant every role dispatch
 * failed while reporting success.
 *
 * Never pin a model name in code again: ask the CLI, and fall back to a slug that is
 * verified against a real build.
 */

export type ModelClass = "fast" | "balanced" | "frontier";

export interface ModelCatalog {
  slugs: string[];
  source: "agy models" | "unavailable";
}

/** Fallbacks, verified present in AntiGravity 1.2.1. Exported so a test can prove they still exist. */
export const FALLBACK_MODEL_SLUGS: Record<ModelClass, string> = {
  fast: "gemini-3.8-flash-low",
  balanced: "gemini-3.8-flash-medium",
  frontier: "gemini-3.8-flash-high",
};

export const MODEL_CLASS_ENV: Record<ModelClass, string> = {
  fast: "OMA_MODEL_FAST",
  balanced: "OMA_MODEL_BALANCED",
  frontier: "OMA_MODEL_FRONTIER",
};

let cachedCatalog: ModelCatalog | undefined;
let cachedResolved: Partial<Record<ModelClass, string>> = {};

/** `agy models` prints `<slug>\t<display name>` per line. Its exit status is unreliable. */
export function readModelCatalog(): ModelCatalog {
  if (cachedCatalog !== undefined) return cachedCatalog;
  try {
    const binary = AgyDriver.resolveAgyBinary();
    if (binary === undefined || binary.length === 0) {
      cachedCatalog = { slugs: [], source: "unavailable" };
      return cachedCatalog;
    }
    const result = spawnSync(binary, ["models"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    const slugs = String(result.stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.split("\t")[0].trim())
      .filter((slug) => /^[a-z0-9][a-z0-9.-]*$/u.test(slug));
    cachedCatalog = slugs.length > 0 ? { slugs, source: "agy models" } : { slugs: [], source: "unavailable" };
  } catch {
    cachedCatalog = { slugs: [], source: "unavailable" };
  }
  return cachedCatalog;
}

/** Test seam: forget the cached catalogue and resolved slugs. */
export function resetModelCatalogCache(): void {
  cachedCatalog = undefined;
  cachedResolved = {};
}

/**
 * The newest slug of a given family and tier.
 *
 * Slugs are versioned (`gemini-3.8-flash-low`), so "newest" is numeric-descending on the
 * version and then on the tier the caller asked for.
 */
export function pickModelSlug(
  slugs: readonly string[],
  options: { family: "flash" | "pro" | "any"; tier?: "low" | "medium" | "high" },
): string | undefined {
  const matching = slugs
    .map((slug) => {
      const match = /^(?<family>[a-z]+)-(?<version>\d+(?:\.\d+)*)-(?<kind>flash|pro)(?:-(?<tier>low|medium|high))?$/u.exec(
        slug,
      );
      if (match?.groups === undefined) return undefined;
      const { family, version, kind, tier } = match.groups as {
        family: string;
        version: string;
        kind: string;
        tier?: string;
      };
      if (options.family !== "any" && kind !== options.family) return undefined;
      if (options.tier !== undefined && tier !== options.tier) return undefined;
      const versionParts = version.split(".").map((part) => Number(part));
      return { slug, versionParts, tier: tier ?? "" };
    })
    .filter((entry): entry is { slug: string; versionParts: number[]; tier: string } => entry !== undefined);

  if (matching.length === 0) return undefined;
  matching.sort((left, right) => {
    for (let index = 0; index < Math.max(left.versionParts.length, right.versionParts.length); index += 1) {
      const difference = (right.versionParts[index] ?? 0) - (left.versionParts[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return right.tier.localeCompare(left.tier);
  });
  return matching[0].slug;
}

/**
 * Resolve a model class to a slug the installed build accepts.
 *
 * Order: an explicit `OMA_MODEL_*` override, then the catalogue, then a verified fallback.
 */
export function resolveModelForClass(modelClass: ModelClass): string {
  const override = process.env[MODEL_CLASS_ENV[modelClass]]?.trim();
  if (override !== undefined && override.length > 0) return override;

  const cached = cachedResolved[modelClass];
  if (cached !== undefined) return cached;

  const { slugs } = readModelCatalog();
  const resolved =
    modelClass === "fast"
      ? (pickModelSlug(slugs, { family: "flash", tier: "low" }) ??
        pickModelSlug(slugs, { family: "flash" }))
      : modelClass === "balanced"
        ? (pickModelSlug(slugs, { family: "flash", tier: "medium" }) ??
          pickModelSlug(slugs, { family: "flash" }))
        : (pickModelSlug(slugs, { family: "pro", tier: "high" }) ??
          pickModelSlug(slugs, { family: "pro" }) ??
          pickModelSlug(slugs, { family: "flash", tier: "high" }) ??
          pickModelSlug(slugs, { family: "flash" }));

  cachedResolved = { ...cachedResolved, [modelClass]: resolved ?? FALLBACK_MODEL_SLUGS[modelClass] };
  return cachedResolved[modelClass] as string;
}
