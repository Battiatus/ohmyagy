# Délégation Claude Code : lot 1

## Suivi

- Terminé : test réel de la passerelle, job `claude-mtvxh0ia-d711b12d`, réponse exacte `OMA_BRIDGE_OK`, aucun refus.
- Terminé : clone local séparé créé depuis `4c5b2ba6a23e5b34a4ed5d1b4995932087debfa5` avec dépendances copiées.
- En cours : implémentation par Claude Code des invariants de réussite et du rattachement mission/graphe.
- À faire : revue des modifications et validation indépendante MCP/CLI.
- À faire : intégration des seules modifications validées dans le checkout utilisateur et bilan.

Le connecteur ne crée pas d'isolation en mode écriture. Un clone temporaire distinct lui est donc fourni. Aucun appel Antigravity ou DeepSeek n'est prévu.

## Brief transmis

Implement the bounded first remediation batch for OMA. This is authorized implementation, not another architecture proposal. You own ONLY this batch in your provided isolated clone. You are not alone in the broader codebase; do not revert other people's work, alter the original checkout, or read/write outside the clone except installed tools and normal OS temp test fixtures. Do not delegate to other agents, providers or connectors. Do not invoke AGY, Antigravity, DeepSeek or any cloud integration. Do not modify global/user configs, install software, push, or commit. Use the existing model/configuration inherited by Claude Code.

Read docs/audits/2026-09-10-oma/REPORT.md and probe.mjs, then the actual source. Audit baseline is commit 4c5b2ba6a23e5b34a4ed5d1b4995932087debfa5. Preserve the six canonical roles and existing graph CAS/kernel design. Smallest correct patch, no broad redesign.

Required outcomes:

1. A graph initialized with only an objective and its synthetic bootstrap cannot be reported as a successful business mission. Bootstrap may remain completed as a dependency seed, but does not count as accomplished work. Planning remains visible and future real nodes can still be added normally. Do not fix this by merely relying on prompt wording or by blocking all subsequent legitimate completion.
2. converge_step must not accept isIntegrated:true as authority for success while executable work remains ready/running/blocked/failed, or failure/gate metrics contradict success. Legitimate completed graph success must continue to work. Keep isIntegrated:false as an integration veto if the existing public contract needs it.
3. Current node progress must be derived from current graph state on every step, even when progressHistory exists. Correct accepted/total counts without discarding meaningful test/gate failure metrics. History serves stagnation detection, not as stale current node counters.
4. Bind the session-native graph to its durable mission identity. Reject a mismatched explicit missionId BEFORE any graph, journal or Brain mutation. Cover converge_step, graph_mark_node, graph_apply and graph_replan, and prevent misleading read-only status/inspection attribution where relevant. Missing missionId must use the graph's binding even after that mission is terminal, not create an oma-session or attach another recent mission. Do not invent a new mission for existing graph state. Keep read-only not_initialized behavior for clean workspaces. Preserve sensible existing lower-level graph usage without a session binding; inspect callers before selecting compatibility behavior. Validate any new file-path use at the external interface.

Non-goals for this batch: replacing singleton graph storage with per-mission storage, lease/epoch ownership, hook registration fixes, Flash memory queue, memory query redesign, DB migration, full host conversation import, generic taxonomy cleanup. State remaining issues honestly.

Suggested ownership: src/orchestration/convergence-step.ts; src/mcp/orchestration-tools.ts; src/mcp/graph-tools.ts; minimal shared mission identity/projection helpers where justified; regression tests in corresponding existing test suites; docs/audits/2026-09-10-oma/claude-lot1-evidence.md. If correctness requires another closely related file, document why. Do not edit .agents, .claude, package manifests, lockfiles or the existing audit results/report.

Verification:

- Add meaningful regressions through the real production interfaces. Demonstrate failure on original code before fixing, then passing. Cover bootstrap-only, ready-node forced success, stale counts, foreign mission rejection with byte-for-byte unchanged relevant state, positive valid completion, and continuing graph planning after bootstrap.
- Do not remove or weaken a failing test. Existing assertions that explicitly require the old erroneous contract may be updated only with an explanation and replacement coverage of the corrected invariant.
- Run npm run build and appropriate targeted Bun tests. Use existing Bun test tooling; some tests import bun:test, so node --test is not interchangeable.
- Avoid the full legacy suite if it launches actual AGY; select local tests. Run a minimal compiled broker JSON-RPC/CLI scenario too.
- Write evidence commands, observed failing/passing results, changed files and limitations to docs/audits/2026-09-10-oma/claude-lot1-evidence.md. No fabricated results, no as any, ts-ignore or ts-expect-error.

Return the requested structured review schema. Use verdict approve only when this batch is implemented and verified; otherwise needs-attention with concrete unfinished work. Include actual verification results in summary and next_steps. Your verdict will be independently reviewed and is not final acceptance.

## Exécution observée

- Job implementation : `claude-mtwnn9c1-985b5c42`.
- Création effective : 2026-09-11T07:48:52Z (09:48 Paris), démarrage fournisseur : 07:48:54Z. Le lancement préparé le 10 septembre ne constitue pas un démarrage le 10 septembre.
- Clone : `C:/Users/User/AppData/Local/Temp/oma-claude-lot1-20260910-1789069014563`.
- Session native Claude observée : `345f31bd-1f55-4723-bf48-a40a6445dd57`.
- Contrôles indépendants ajoutés : `verify-lot1.mjs`; état initial : 11 échecs attendus, 0 réussite. Résultats dans `lot1-independent-baseline.json`.
- Aucun correctif produit intégré tant que le patch et ses tests ne sont pas vérifiés.
