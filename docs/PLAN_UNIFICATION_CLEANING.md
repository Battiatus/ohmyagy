# Plan d'exécution granulaire v2 — Unification & nettoyage OMA (pour Gemini)

**Statut** : `ready-for-agent` · Fondé sur `docs/ANALYSE_VISION_VS_CODE.md` + retours Kronos (v2).
**Format** : tâches atomiques `T<phase>.<n>` (Action · Fichiers · Réutilise · Test · Acceptance · Dépend). Une tâche = un commit. Build + test de la tâche après CHAQUE tâche ; jamais avancer sur du rouge.

---

## Recadrages intégrés en v2 (retours Kronos) + 3 garde-fous techniques

**Intégrés** : (1) *Late-Init* — OMA s'invoque en cours de conversation et ingère le contexte ; (2) **sas d'interview obligatoire** avant tout run ; (3) **6 rôles canoniques uniquement**, les modes (debug/fix/feature/infra) = **configs de skill/prompt** appliquées aux rôles, pas des agents ; (4) mémoire **Flash (contexte, actions)** liée aux nœuds ; (5) **replanning dynamique** (échec verifier → nœud de diagnostic).

**Garde-fous techniques (là où je diverge de Kronos, à challenger)** :
- **G1 — Pas de purge aveugle du « headless ».** `dynamic-engine.ts`/`real-mission.ts` contiennent les garanties d'ingénierie (blocage, progrès, vagues, CAS). On **extrait** cette logique (Phase 3) et on **retire seulement le lancement détaché** (Phase 8), après unification. Supprimer avant extraction = perte des garanties (obligation Graph Engineering).
- **G2 — `transcript.jsonl` = hypothèse.** L'ingestion du contexte de la session active est **native** (le skill tourne dans la session). Le fichier transcript est secondaire (cross-session) et **à vérifier** avant de s'en servir.
- **G3 — Mémoire = 2 tables, pas 1.** On garde les 5 dimensions durables (décisions/erreurs/préférences) **et** le journal `(contexte, actions)` ; on ajoute `node_ref`. Ne pas collapser sur le seul journal.

---

## PHASE 0 — Pré-conditions

- **T0.1 — Restaurer un HEAD buildable.** `git add` des non-suivis (`src/brain/`, `src/mcp/*tools.ts`, tests, `src/plugin-assets/`, `docs/`) + 1 commit. Motif : HEAD importe des modules non commités → ne build pas. **Requiert accord utilisateur.**
- **T0.2 — Baseline verte.** `npm run build` exit 0 + `bun test` : noter ~262 pass / 4 fail pré-existants (baseline immuable).

**Contraintes** : SQLite via `sqlite-adapter.ts` · pas de WAL · teardown `removeTree` · ESM `.js` · refactor sans changement de comportement · zéro slop · capture mémoire fail-open.

---

## PHASE 1 — Taxonomie : 6 rôles canoniques, modes-en-config

> **Principe (Kronos)** : les 6 rôles sont les **seuls** agents dispatchables. `debug/fix/feature/infra/refactor` = **configs** (skill/prompt) appliquées à ces rôles, jamais des agents en dur.
> **Garde-fou** : alias, pas rename dur de `worker` (27 refs).

- **T1.1 — `VisionRole` + `ROLE_ALIASES`.** `type VisionRole = "orchestrator"|"planner"|"explorer"|"executor"|"reviewer"|"verifier"` ; `ROLE_ALIASES` (executor→`worker`, orchestrator→session). *Fichiers* : `capability-resolver.ts`. *Test* : `capability-resolver.test.ts`. *Dépend* : T0.
- **T1.2 — Experts `explorer` + `verifier` dans `CORE_EXPERTS`.** *Test* : résolution readonly correcte. *Dépend* : T1.1.
- **T1.3 — `resolve()` accepte un `VisionRole`.** Rétro-compatible. *Test* : `resolve("executor")` ≡ `resolve("worker")`. *Dépend* : T1.2.
- **T1.4 — 6 fichiers agents exposés** (`orchestrator/planner/explorer/executor/reviewer/verifier.md` + `summarizer.md`). *Fichiers* : `src/plugin-assets/agents/`. *Dépend* : T1.1.
- **T1.5 — Archiver les `.md` morts** (`atlas/metis/themis/sisyphus/forensic/prometheus/repairer` → `docs/archive/agents/`). *Test* : grep de ces noms dans `src/**.ts` (hors test) = 0. *Dépend* : T1.4.
- **T1.6 — Aligner la skill `oma-start`** sur les 6 rôles (3 copies, md5 égaux). *Test* : grep `sisyphus|metis|themis` sur skills = 0. *Dépend* : T1.5.
- **T1.7 — MàJ `install.ts`** (liste d'agents). *Test* : `broker-server.test.ts` install vert. *Dépend* : T1.4.
- **T1.8 — Rename canonique `worker`→`executor` (dur + alias rétrocompat).** *Action* : id/enum canonique = `executor` dans `ExpertSpec.role` + `CORE_EXPERTS` + docs ; garder `worker` comme **alias de rétrocompat** (`if (role === "worker") role = "executor"`) pour ne rien casser des 27 refs/configs. **Tâche isolée, exécutée en dernier de la Phase 1**, après que T1.1-T1.7 sont verts. *Fichiers* : `capability-resolver.ts` + les 27 sites + tests concernés. *Test* : **`bun test` complet** vert (pas seulement l'unité). *Acceptance* : `executor` canonique partout, `worker` encore accepté. *Dépend* : T1.1-T1.7. *Risque* : moyen (churn) → commit isolé, revert facile.

---

## PHASE 2 — Routage par mode/besoin (config sur les 6 rôles)

> **Principe** : un « besoin » sélectionne un **sous-ensemble de rôles + une config de mode** (prompt/skill), pas de nouveaux agents.

- **T2.1 — `MissionMode` + `rolesForMode()`.** `src/runtime/mode-router.ts` : `type MissionMode = "debug"|"bugfix"|"feature"|"refactor"|"infra"|"project-management"|"review"|"exploration"` ; `rolesForMode(m): VisionRole[]` (table explicite, défaut sûr). **Table-graine validée** :
  - `bugfix`/`debug` (patch rapide) → `[planner(light), executor, verifier]`
  - `feature`/`refactor` → `[planner, explorer, executor, reviewer, verifier]`
  - `review`/diagnostic/post-mortem → `[explorer, reviewer]` (lecture seule, root-cause)
  - `infra` → `[planner, executor, verifier]` · `project-management` → `[planner, orchestrator]`
  *Réutilise* : `VisionRole`. *Test* : `mode-router.test.ts` (chaque mode → topologie attendue). *Dépend* : T1.3.
- **T2.2 — Config de mode (prompt overlay).** Structure `ModeConfig { extraGates?, promptOverlay?, sandbox? }` par mode, appliquée au dispatch des rôles. *Test* : chaque mode → config déterministe. *Dépend* : T2.1.
- **T2.3 — Outil MCP `plan_route {mode}`** → `{roles, modeConfig}`. `src/mcp/routing-tools.ts` (patron graph-tools) + câblage broker + comptage test. *Test* : `routing-tools.test.ts`. *Dépend* : T2.2.

---

## PHASE 3 — Unifier l'orchestration (extraire le moteur, cœur ⭐)

> **G1** : on extrait la logique ; on ne supprime rien ici.

- **T3.1 — Cartographier** la boucle de `DynamicConvergenceEngine.execute` (commentaire, zéro code). *Dépend* : T0.
- **T3.2 — Extraire `evaluateConvergenceStep()` (pure).** Types `ConvergenceStepInput/Result` (ci-dessous). *Fichiers* : `dynamic-engine.ts`/`convergence-step.ts`. *Test* : `convergence-step.test.ts` (progrès, blocage 2 rounds, convergence, budget). *Dépend* : T3.1.
  ```ts
  export function evaluateConvergenceStep(i: { graph: ExecutionGraph; events: GraphEvent[]; progressHistory: ProgressVector[]; limits: DynamicWorkflowLimits; }): { readyNodes: ProjectedNode[]; progress: ProgressVector; status: "in_progress"|"succeeded"|"failed"|"no_progress_blocked"|"budget_exhausted"; diagnosis?: string };
  ```
- **T3.3 — Brancher `execute()` dessus (non-régression).** *Test* : suites `dynamic-engine`/`real-mission` **inchangées et vertes**. *Dépend* : T3.2.
- **T3.4 — Outil MCP `converge_step`.** `src/mcp/orchestration-tools.ts`. *Réutilise* : `loadGraphRuntime`, `evaluateConvergenceStep`. *Test* : `orchestration-tools.test.ts`. *Dépend* : T3.3.
- **T3.5 — Outil MCP `converge_status` (read-only).** *Dépend* : T3.4.
- **T3.6 — Replanning dynamique `graph_replan`.** Sur échec verifier, insère un nœud de diagnostic (explorer/executor) via `GraphProposal` (réutilise `publishRepairNodes`/`graph_propose`). *Réutilise* : logique repair de `real-mission.ts`. *Test* : `orchestration-tools.test.ts` — verdict d'échec → nœud de diagnostic prêt. *Dépend* : T3.4.
- **T3.7 — Câbler orchestration-tools dans le broker** (definitions/dispatch/isError/comptage `broker-server.test.ts`). *Dépend* : T3.4, T3.6.

---

## PHASE 4 — Conducteur session-native : Late-Init + Sas d'interview + boucle

> **Recadrages 1 & 2 (Kronos)** : ingestion du contexte puis **questions obligatoires** avant tout run. **G2** : ingestion native d'abord, transcript file en secondaire.

- **T4.1 — Late-Init : ingestion de contexte à 3 niveaux (résolution en cascade).** La skill `oma-start` Step 1 :
  - *Niveau 1 — primaire (nominal)* : contexte conversationnel **actif** de la session (le LLM voit déjà l'historique ; aucun I/O disque requis).
  - *Niveau 2 — cross-session (cold start)* : `brain_query` sur `project_id` + état du graphe rechargé depuis SQLite/ledger.
  - *Niveau 3 — optionnel* : fichier transcript de session **si** le runtime le fournit, sinon **omission gracieuse**.
  *Fichiers* : `oma-start/SKILL.md` (3 copies). *Test* : revue (skill) + md5 égaux. *Dépend* : T0. *Note* : documenter le résultat de la vérif « transcript accessible ? ».
- **T4.2 — Sas d'interview obligatoire, chirurgical (bloquant).** Step 2, séquence stricte :
  1. OMA **résume en 2-3 phrases** ce qu'il a décortiqué (discussion passée + état projet/DB).
  2. Il pose **2-3 questions ciblées** seulement, sur les frictions réelles : objectifs mesurables, contraintes techniques, choix d'architecture, **mode requis**.
  3. **Dès validation utilisateur** → instanciation du graphe + démarrage de la boucle. **Aucun run avant réponses.**
  *Fichiers* : skill. *Test* : revue — présence du gate « pas de run avant réponses » + format résumé/2-3 questions. *Dépend* : T4.1.
- **T4.3 — Sélection de mode → routage.** Après l'interview, la skill appelle `plan_route {mode}` (Phase 2) pour déployer les bons rôles. *Dépend* : T4.2, T2.3.
- **T4.4 — Boucle native pilotée par `converge_step`.** Step 5 : boucle `graph_ready_nodes`/`converge_step` → dispatch rôles → 2PC (`propose_change`→`attest_review`→gates→`promote_change`) → `graph_mark_node` ; `no_progress_blocked`→arrêt+diagnosis ; échec verifier→`graph_replan`. *Dépend* : T4.3, T3.7.

---

## PHASE 5 — Mémoire Flash canonique, alimentée depuis TOUT

> **Recadrage 4 + G3** : forme canonique `(contexte, actions)` liée aux nœuds, **en plus** des 5 dimensions durables.

- **T5.1 — Étendre `interaction_summaries` avec `node_ref`.** Migration additive (colonne nullable `node_ref`). *Fichiers* : `brain-store.ts` (SCHEMA + `RecordInteractionInput`). *Test* : `brain-store.test.ts` — round lié à un nœud. *Dépend* : T0.
- **T5.2 — Forme canonique (contexte, actions) dans le résumeur.** Le prompt Flash produit `{context, actions}` (+ dimension optionnelle). Adapter `summarizer.ts`/`flash-summarizer.ts` : `context`→`interaction.userIntent`/`context_summary`, `actions`→`actionsTaken`. *Test* : `summarizer.test.ts` mis à jour. *Dépend* : T5.1.
- **T5.3 — `ingestMissionIntoBrain()` (fail-open, idempotent, avec `node_ref`).** `src/brain/mission-ingest.ts` : projection → `run_summary`/vague + `past_error`/gate, liés au `node_ref`. *Réutilise* : `MissionProjectionEngine`, `BrainStore`. *Test* : `mission-ingest.test.ts`. *Dépend* : T5.1.
- **T5.4 — Brancher les deux chemins.** `RealMissionExecutor` (détaché, tant qu'il existe) **et** conducteur session (`converge_step`/fin de round) appellent l'ingest. *Test* : après un run, `brain_query` retourne des mémoires liées aux nœuds. *Dépend* : T5.3, T3.4.

---

## PHASE 6 — Suivi unifié

- **T6.1 — Source unique = ledger mission (`MissionProjectionEngine`).** (décision documentée). *Dépend* : T0.
- **T6.2 — Le mode session émet les événements mission** (même `eventsPath`), pour que `listMissions`/`summarizeMission` voient le run. *Test* : run session listé + résumé. *Dépend* : T6.1, T3.7.
- **T6.3 — `findActiveMissionId` voit le run session.** *Test* : `/oma:status` sans arg → run session. *Dépend* : T6.2.

---

## PHASE 7 — Cycle de vie mémoire (petite DB)

- **T7.1 — `BrainStore.compact()`** (dédup, élagage `run_summary` anciens/faible confiance, repli des vieux `interaction_summaries` ; préserve décisions/préférences). *Test* : `brain-compaction.test.ts`. *Dépend* : T5.1.
- **T7.2 — Déclencheur** (hook résumeur après N rounds ou outil `brain_compact`, fail-open). *Test* : DB bornée sous charge. *Dépend* : T7.1.

---

## PHASE 8 — Retrait du lancement détaché (Option B, APRÈS unification — G1)

> **Portée précise (G1 renforcé)** : on retire **la tuyauterie de lancement détaché**, PAS le moteur. `RealMissionExecutor`/`dynamic-engine` **restent comme bibliothèque** — ils sont encore utilisés par le benchmark (`src/benchmark/real-benchmark.ts:146`, `benchmark-runner.ts:224`). Éradiquer le moteur casserait `oma benchmark`.

- **T8.1 — Retirer `launchDetachedCli` + le spawn détaché** de `run_mission`/`resume_mission` dans `broker-server.ts` ; repointer ces outils vers le chemin session-native (ou les retirer). *Test* : migrer/retirer « run_mission returns a watchable mission id » (`broker-server.test.ts:163`). *Dépend* : Phases 3-6 vertes.
- **T8.2 — `/oma:start` = entrée unique.** Retirer de l'expo `/oma:run` détaché. **Conserver `RealMissionExecutor`/`dynamic-engine` comme bibliothèque** (utilisée en session via les outils `converge_*` et par le benchmark). *Test* : suite complète verte ; `grep -rn "detached: true" src` = 0 (plus aucun spawn fantôme). *Dépend* : T8.1.

---

## Portes d'acceptation globales
- [ ] build 0 ; `bun test` sans **nouveau** fail (4 pré-existants inchangés).
- [ ] Suites moteur (`dynamic-engine`, `real-mission`) inchangées & vertes (non-régression T3.3).
- [ ] Conducteur : Late-Init + **interview bloquante** + boucle `converge_step` + `graph_replan`.
- [ ] Mémoire : `(context, actions)` + `node_ref` + dimensions ; runs (2 chemins) peuplent le brain ; DB compactée.
- [ ] 6 rôles seuls exposés, modes = configs ; morts archivés.
- [ ] `/oma:status` voit un run session ; (Phase 8 si retenue) plus aucun spawn détaché.
- [ ] Scan anti-slop propre.

## Décisions arbitrées (verrouillées — retours Kronos, 8 sept. 2026)
1. **T0.1 commit de restauration** : ✅ **OUI, obligatoire** avant Phase 1. Neutraliser l'auto-committer OMA pendant l'opération pour éviter un commit partiel concurrent.
2. **Phase 8 (retrait détaché)** : ✅ **Option B** (retrait total), mais **en dernier** (G1) et **scopé à la tuyauterie détachée** — le moteur reste bibliothèque (benchmark).
3. **`worker`→`executor`** : ✅ **Rename dur canonique + alias `worker` rétrocompat** (T1.8, isolé en fin de Phase 1, suite complète verte).
4. **Tables `rolesForMode`/`ModeConfig`** : ✅ **Validées**, topologies-graines dans T2.1.
5. **Transcript de session** (T4.1) : ✅ **Non bloquant** — résolution 3 niveaux (actif → SQLite → transcript optionnel).

## Reste à vérifier avant/pendant l'exécution
- **Existence d'un transcript de session accessible** (T4.1 niveau 3) : à confirmer côté runtime Antigravity ; omission gracieuse sinon.

## Références
`docs/ANALYSE_VISION_VS_CODE.md` · `src/orchestration/{dynamic-engine,real-mission}.ts` · `src/mcp/{brain,graph}-tools.ts` · `src/mission/read-model.ts` + `src/graph/mission-projections.ts` · `src/runtime/capability-resolver.ts` · `src/brain/summarizer.ts`.
