import { discardStagedTransaction, stageProposal, } from "./staging.js";
import { PromotionError, promoteApprovedTransaction, } from "./promotion.js";
import { JournalRefusal } from "../ledger/mission-journal.js";
export class StagedReviewBroker {
    journal;
    #records = new Map();
    constructor(journal) {
        this.journal = journal;
    }
    stage(context, repositoryRoot, proposal) {
        const staged = stageProposal(repositoryRoot, proposal);
        try {
            this.journal.appendTransactionStaged({
                runKey: context.runKey,
                missionId: context.missionId,
                leaseId: context.leaseId,
                epoch: context.epoch,
                transactionId: staged.transaction.transactionId,
                stagedDiffDigest: staged.stagedDiffDigest,
            });
        }
        catch (error) {
            discardStagedTransaction(staged);
            throw error;
        }
        this.#records.set(staged.transaction.transactionId, {
            context: Object.freeze({ ...context }),
            staged,
            canonicalDiff: staged.canonicalDiff,
            stagedDiffDigest: staged.stagedDiffDigest,
        });
        return staged;
    }
    promote(context, transactionId, approval) {
        const record = this.requireRecord(context, transactionId);
        try {
            this.journal.assertPromotionAllowed({
                runKey: context.runKey,
                missionId: context.missionId,
                leaseId: context.leaseId,
                epoch: context.epoch,
                transactionId,
                stagedDiffDigest: record.stagedDiffDigest,
                diffDigest: record.stagedDiffDigest,
            });
            const promoted = promoteApprovedTransaction(approval, {
                missionId: context.missionId,
                runKey: context.runKey,
                expectedStagedDiffDigest: record.stagedDiffDigest,
            });
            this.journal.appendTransactionPromoted({
                runKey: context.runKey,
                missionId: context.missionId,
                leaseId: context.leaseId,
                epoch: context.epoch,
                transactionId,
                stagedDiffDigest: promoted.stagedDiffDigest,
                commitSha: promoted.commitSha,
                diffDigest: promoted.diffDigest,
            });
            return { transaction: "promoted", reasonCode: "promoted", ...promoted };
        }
        catch (error) {
            if (error instanceof JournalRefusal &&
                error.reasonCode === "unreviewed_promotion") {
                discardStagedTransaction(record.staged);
                this.#records.delete(transactionId);
                return {
                    transaction: "rejected",
                    reasonCode: "unreviewed_promotion",
                    transactionId,
                };
            }
            if ((error instanceof PromotionError && error.code === "staged_promoted_mismatch") ||
                (error instanceof JournalRefusal && error.reasonCode === "staged_promoted_mismatch")) {
                return {
                    transaction: "conflict",
                    reasonCode: "staged_promoted_mismatch",
                    transactionId,
                };
            }
            throw error;
        }
    }
    stagedDiff(runKey, transactionId) {
        const record = this.#records.get(transactionId);
        return record?.context.runKey === runKey ? record.canonicalDiff : undefined;
    }
    requireRecord(context, transactionId) {
        const record = this.#records.get(transactionId);
        if (!record ||
            record.context.missionId !== context.missionId ||
            record.context.runKey !== context.runKey ||
            record.context.leaseId !== context.leaseId ||
            record.context.epoch !== context.epoch) {
            throw new PromotionError("not_approved", `Transaction ${transactionId} is not staged under the supplied run authority.`);
        }
        return record;
    }
}
