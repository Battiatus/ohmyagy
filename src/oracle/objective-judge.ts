import { sha256 } from "../ledger/canonical.js";
import { runHiddenPipelineTests, type TestRunResult } from "./hidden-tests/minimal-pipeline-hidden.js";

export interface ProgressVector {
  hiddenTestsFailing: number;
  hiddenTestsPassed: number;
  visibleTestsFailing: number;
  visibleTestsPassed: number;
  gateFailures: number;
  openDiagnosticsCount: number;
  acceptedWorkItems: number;
  totalWorkItems: number;
}

export interface JudgeVerdict {
  status: "approved" | "rejected";
  progressVector: ProgressVector;
  visibleResults: TestRunResult[];
  hiddenResults: TestRunResult[];
  diagnostics: string[];
  verdictHash: string;
  durationMs: number;
}

export interface PipelineModuleBundle {
  math: { add: Function; multiply: Function; fibonacci: Function };
  parser: { parseExpression: Function };
  pipeline: { evaluatePipeline: Function };
}

export class ObjectiveJudge {
  /**
   * Evaluates a module bundle against both visible and hidden test suites.
   */
  public static evaluatePipelineBundle(
    bundle: PipelineModuleBundle,
    options: { totalWorkItems?: number; acceptedWorkItems?: number } = {},
  ): JudgeVerdict {
    const startTime = Date.now();
    const visibleResults: TestRunResult[] = [];
    const diagnostics: string[] = [];

    // 1. Run Visible Tests
    try {
      if (
        bundle.math.add(2, 3) !== 5 ||
        bundle.math.multiply(4, 5) !== 20 ||
        bundle.math.fibonacci(5) !== 5
      ) {
        visibleResults.push({
          name: "visible: math basic operations",
          passed: false,
          error: "Math operations returned incorrect results for basic inputs",
        });
      } else {
        visibleResults.push({ name: "visible: math basic operations", passed: true });
      }
    } catch (err) {
      visibleResults.push({
        name: "visible: math basic operations",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const p1 = bundle.parser.parseExpression("2 + 3");
      const p2 = bundle.parser.parseExpression("4 * 5");
      const p3 = bundle.parser.parseExpression("fib(5)");
      if (
        p1.op !== "add" ||
        p2.op !== "multiply" ||
        p3.op !== "fib" ||
        p1.args[0] !== 2 ||
        p1.args[1] !== 3
      ) {
        visibleResults.push({
          name: "visible: parser basic expressions",
          passed: false,
          error: "Parser returned incorrect AST for basic expressions",
        });
      } else {
        visibleResults.push({ name: "visible: parser basic expressions", passed: true });
      }
    } catch (err) {
      visibleResults.push({
        name: "visible: parser basic expressions",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const res = bundle.pipeline.evaluatePipeline(["2 + 3", "4 * 5", "fib(5)"]);
      if (res.steps.length !== 3 || res.aggregateSum !== 30 || res.aggregateProduct !== 500) {
        visibleResults.push({
          name: "visible: pipeline evaluates sequence",
          passed: false,
          error: `Pipeline evaluation mismatch: sum=${res.aggregateSum}, prod=${res.aggregateProduct}`,
        });
      } else {
        visibleResults.push({ name: "visible: pipeline evaluates sequence", passed: true });
      }
    } catch (err) {
      visibleResults.push({
        name: "visible: pipeline evaluates sequence",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Run Hidden Tests (Judge authority)
    const hiddenResults = runHiddenPipelineTests(bundle);

    const visiblePassed = visibleResults.filter((r) => r.passed).length;
    const visibleFailing = visibleResults.length - visiblePassed;
    const hiddenPassed = hiddenResults.filter((r) => r.passed).length;
    const hiddenFailing = hiddenResults.length - hiddenPassed;

    for (const r of [...visibleResults, ...hiddenResults]) {
      if (!r.passed && r.error) {
        diagnostics.push(`[${r.name}] ${r.error}`);
      }
    }

    const approved = visibleFailing === 0 && hiddenFailing === 0;

    const progressVector: ProgressVector = {
      hiddenTestsFailing: hiddenFailing,
      hiddenTestsPassed: hiddenPassed,
      visibleTestsFailing: visibleFailing,
      visibleTestsPassed: visiblePassed,
      gateFailures: approved ? 0 : 1,
      openDiagnosticsCount: diagnostics.length,
      acceptedWorkItems: options.acceptedWorkItems ?? (approved ? (options.totalWorkItems ?? 3) : 0),
      totalWorkItems: options.totalWorkItems ?? 3,
    };

    const durationMs = Date.now() - startTime;
    const verdictPayload = JSON.stringify({
      status: approved ? "approved" : "rejected",
      progressVector,
      diagnostics,
    });
    const verdictHash = sha256(verdictPayload);

    return {
      status: approved ? "approved" : "rejected",
      progressVector,
      visibleResults,
      hiddenResults,
      diagnostics,
      verdictHash,
      durationMs,
    };
  }

  /**
   * Compares two progress vectors lexicographically to determine strict improvement.
   * Returns true if v2 represents measurable progress over v1.
   */
  public static isProgressing(v1: ProgressVector, v2: ProgressVector): boolean {
    // 1. Fewer hidden test failures
    if (v2.hiddenTestsFailing < v1.hiddenTestsFailing) return true;
    if (v2.hiddenTestsFailing > v1.hiddenTestsFailing) return false;

    // 2. Fewer visible test failures
    if (v2.visibleTestsFailing < v1.visibleTestsFailing) return true;
    if (v2.visibleTestsFailing > v1.visibleTestsFailing) return false;

    // 3. More accepted work items
    if (v2.acceptedWorkItems > v1.acceptedWorkItems) return true;
    if (v2.acceptedWorkItems < v1.acceptedWorkItems) return false;

    // 4. Fewer open diagnostics
    if (v2.openDiagnosticsCount < v1.openDiagnosticsCount) return true;

    return false;
  }
}
