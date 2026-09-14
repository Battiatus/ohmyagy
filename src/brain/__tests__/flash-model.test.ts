import assert from "node:assert/strict";
import { test } from "bun:test";
import { pickFlashModel, resolveFlashModel } from "../flash-summarizer.js";

/**
 * The reformulator hardcoded `gemini-2.5-flash`, which AntiGravity 1.2.1 does not know:
 * `agy models` lists Gemini 3.8/3.7/3.6 Flash tiers, 3.1 Pro, Claude and GPT-OSS. The
 * name had rotted, and because the process runner also swallowed the child's error, the
 * failure was invisible. Model selection must therefore follow the installed build.
 */

test("picks the cheapest Flash tier the build offers", () => {
  const models = [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.1-pro-high",
  ];
  assert.equal(pickFlashModel(models), "gemini-3.8-flash-low");
  assert.equal(pickFlashModel(["gemini-3.8-flash-medium", "gemini-3.1-pro-high"]), "gemini-3.8-flash-medium");
  assert.equal(pickFlashModel(["gemini-3.8-flash-high"]), "gemini-3.8-flash-high");
  assert.equal(pickFlashModel(["gemini-3.1-pro-high", "claude-sonnet-4-6"]), undefined);
});

test("an explicit model override is used verbatim and never resolved", () => {
  const previous = process.env.OMA_FLASH_MODEL;
  process.env.OMA_FLASH_MODEL = "some-custom-flash";
  try {
    assert.equal(resolveFlashModel(), "some-custom-flash");
  } finally {
    if (previous === undefined) {
      delete process.env.OMA_FLASH_MODEL;
    } else {
      process.env.OMA_FLASH_MODEL = previous;
    }
  }
});
