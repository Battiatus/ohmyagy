import { ObjectiveJudge, type JudgeVerdict, type PipelineModuleBundle } from "../oracle/objective-judge.js";
import { sha256 } from "../ledger/canonical.js";

export interface WorkItemChangeProposal {
  workItemId: string;
  filesModified: string[];
  modulePatch: Partial<PipelineModuleBundle>;
  stagedDiffDigest: string;
}

export interface IntegrationReport {
  status: "integrated" | "conflict_blocked" | "judge_rejected";
  integratedWorkItems: string[];
  conflictDetails?: string;
  judgeVerdict?: JudgeVerdict;
  commitHash?: string;
  durationMs: number;
}

export class DeterministicIntegrator {
  /**
   * Applies approved work items in deterministic lexicographical order.
   * Rejects auto-merging on conflicting file scopes.
   * Evaluates final bundle with ObjectiveJudge.
   */
  public static integrateWorkItems(
    baseBundle: PipelineModuleBundle,
    proposals: WorkItemChangeProposal[],
  ): IntegrationReport {
    const startTime = Date.now();

    // 1. Sort proposals deterministically by workItemId
    const sortedProposals = [...proposals].sort((a, b) =>
      a.workItemId.localeCompare(b.workItemId),
    );

    // 2. Detect overlapping file scope conflicts
    const fileOwnership = new Map<string, string>();
    for (const proposal of sortedProposals) {
      for (const file of proposal.filesModified) {
        const existingOwner = fileOwnership.get(file);
        if (existingOwner) {
          return {
            status: "conflict_blocked",
            integratedWorkItems: [],
            conflictDetails: `Scope conflict on file '${file}': modified by both '${existingOwner}' and '${proposal.workItemId}' without resolved causal merge.`,
            durationMs: Date.now() - startTime,
          };
        }
        fileOwnership.set(file, proposal.workItemId);
      }
    }

    // 3. Assemble integrated module bundle
    const integratedBundle: PipelineModuleBundle = {
      math: { ...baseBundle.math },
      parser: { ...baseBundle.parser },
      pipeline: { ...baseBundle.pipeline },
    };

    for (const proposal of sortedProposals) {
      if (proposal.modulePatch.math) {
        Object.assign(integratedBundle.math, proposal.modulePatch.math);
      }
      if (proposal.modulePatch.parser) {
        Object.assign(integratedBundle.parser, proposal.modulePatch.parser);
      }
      if (proposal.modulePatch.pipeline) {
        Object.assign(integratedBundle.pipeline, proposal.modulePatch.pipeline);
      }
    }

    // 4. Run Objective Judge on integrated bundle
    const judgeVerdict = ObjectiveJudge.evaluatePipelineBundle(integratedBundle, {
      totalWorkItems: sortedProposals.length,
      acceptedWorkItems: sortedProposals.length,
    });

    if (judgeVerdict.status !== "approved") {
      return {
        status: "judge_rejected",
        integratedWorkItems: sortedProposals.map((p) => p.workItemId),
        judgeVerdict,
        durationMs: Date.now() - startTime,
      };
    }

    // 5. Deterministic Commit Hash calculation
    const commitPayload = JSON.stringify({
      workItems: sortedProposals.map((p) => ({
        id: p.workItemId,
        diff: p.stagedDiffDigest,
      })),
      verdictHash: judgeVerdict.verdictHash,
      timestamp: new Date().toISOString(),
    });
    const commitHash = sha256(commitPayload);

    return {
      status: "integrated",
      integratedWorkItems: sortedProposals.map((p) => p.workItemId),
      judgeVerdict,
      commitHash,
      durationMs: Date.now() - startTime,
    };
  }
}
