import { hashJson } from "../ledger/canonical.js";
export const REVIEW_EVERY_PROMOTION = Object.freeze({
    id: "coverage.review-of-every-promotion",
    description: "Every promoted transaction has an approved independent review attested before promotion.",
    gateId: "coverage.review-of-every-promotion",
});
export const POLICY_REGISTRY = Object.freeze({
    version: "1",
    classes: Object.freeze([
        Object.freeze({
            missionClass: "code-change",
            requiredMissionAcceptance: Object.freeze([REVIEW_EVERY_PROMOTION]),
        }),
        Object.freeze({
            missionClass: "artifact-analysis",
            requiredMissionAcceptance: Object.freeze([]),
        }),
    ]),
});
export const POLICY_REGISTRY_DIGEST = hashJson(POLICY_REGISTRY);
export function resolveMissionAcceptance(missionClass, humanDeclared) {
    const policy = resolvePolicyClass(missionClass);
    const resolved = new Map();
    for (const criterion of [...humanDeclared, ...policy.requiredMissionAcceptance]) {
        const existing = resolved.get(criterion.id);
        if (existing && existing.gateId !== criterion.gateId) {
            throw new Error(`Acceptance criterion ${criterion.id} has conflicting gateIds.`);
        }
        resolved.set(criterion.id, { ...criterion });
    }
    return [...resolved.values()];
}
export function requiresReviewOfEveryPromotion(missionClass) {
    return resolvePolicyClass(missionClass).requiredMissionAcceptance.some((criterion) => criterion.gateId === REVIEW_EVERY_PROMOTION.gateId);
}
function resolvePolicyClass(missionClass) {
    const policy = POLICY_REGISTRY.classes.find((candidate) => candidate.missionClass === missionClass);
    if (!policy) {
        throw new Error(`Mission class ${missionClass} is absent from the policy registry.`);
    }
    return policy;
}
