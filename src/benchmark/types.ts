import type { ProgressVector } from "../oracle/objective-judge.js";

export type BenchmarkVariant =
  | "vanilla_agy"
  | "skills_only"
  | "oma_static_wave"
  | "oma_dynamic_workflow";

export interface BenchmarkSharedBaseline {
  baselineCommitSha: string;
  taskPrompt: string;
  modelSlug: string;
  reasoningEffort: "low" | "medium" | "high";
  timeoutMs: number;
  maxBudgetTokens: number;
  hiddenTestsSuiteId: string;
}

export interface BenchmarkTrialResult {
  variant: BenchmarkVariant;
  trialIndex: number;
  timestamp: string;
  sharedBaseline: BenchmarkSharedBaseline;
  outcome: {
    hiddenTestsPassed: boolean;
    finalProgress: ProgressVector;
    exitStatus: "succeeded" | "failed" | "timed_out" | "blocked";
  };
  metrics: {
    totalDurationMs: number;
    criticalPathDurationMs: number;
    totalTokens: number;
    runsCount: number;
    wavesCount: number;
    discoveredWorkItemsCount: number;
    acceptedAtFirstPassCount: number;
    defectsCaughtByReviewers: number;
    gateFailuresCount: number;
    humanInterventionsCount: number;
  };
}

export interface BenchmarkComparisonSummary {
  taskId: string;
  totalTrialsPerVariant: number;
  resultsByVariant: Record<BenchmarkVariant, {
    successRate: number;
    meanDurationMs: number;
    meanTokens: number;
    meanWaves: number;
    meanDefectsIntercepted: number;
  }>;
  causalFindings: string[];
}
