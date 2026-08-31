# Project: Oh My AntiGravity (OMA)

## Architecture
Oh My AntiGravity (OMA) est un système d'orchestration résilient et déterministe pour agents IA autonomes (AntiGravity CLI / Jetski / Gemini CLI). L'architecture repose sur 6 piliers majeurs :

1. **Runtime & Confinement MoE** (`src/runtime/`, `src/orchestration/worktree-pool.ts`):
   - Résolution de capacités pour 4 experts normatifs : `planner`, `worker`, `reviewer`, `fixer`.
   - Pilote d'exécution headless `AgyDriver` avec confinement physique Win32 Job Object (`KillOnJobClose`), POSIX process groups, et caviardage de secrets.
   - Isolation stricte des tâches dans des Git worktrees temporaires sur branches dédiées.
2. **Noyau de Graphe & Broker CAS** (`src/graph/`):
   - Modèle de graphe orienté acyclique (`ExecutionGraph`, `GraphNode`, `GraphEdge`) avec validation de schéma stricte sans champs cachés.
   - Vérification d'acyclicité $O(V+E)$ par algorithme de Kahn et extraction de cycles par DFS 3-couleurs.
   - Publication atomique CAS de révisions (`graph.lock`, `rev_<N>.json`) et immutabilité stricte des nœuds terminaux.
   - Calcul pur et déterministe du `readySet`.
3. **Dynamic Workflow & Convergence Multi-Vagues** (`src/orchestration/dynamic-engine.ts`, `src/oracle/`):
   - Juge d'objectifs externe (`ObjectiveJudge`) évaluant le code sur tests visibles et cachés, produisant un `ProgressVector`.
   - Boucle de convergence adaptative générant des vagues correctives avec l'expert `fixer` en cas d'échec de porte.
   - Contrôle de progression lexicographique (`isProgressing`) avec garde anti-stagnation.
4. **Traçabilité, Revues Contradictoires & Git 2PC** (`src/ledger/`, `src/broker/`, `src/oracle/adversarial-review.ts`):
   - Journal autoritatif immuable `events.jsonl` chaîné par hachage SHA-256 continu.
   - Diffs Myers canoniques gelés et hachés (`sha256(canonicalDiff)`).
   - Règle stricte $Author \neq Reviewer$ avec consensus multi-examinateurs unanime.
   - Portes de qualité isolées et promotion atomique Two-Phase Commit (`git commit-tree`, `git merge --ff-only`).
5. **Reprise Déterministe de Mission** (`src/orchestration/mission-resumption.ts`, `src/resume/`):
   - Reconstitution déterministe de l'état complet à partir du journal `events.jsonl`.
   - Epoch fencing pour neutraliser les runs zombies interrompus.
   - Conservation des unités de travail validées et relance sélective des tâches incomplètes.
   - Idempotence stricte ($f(f(x)) = f(x)$ sans effet de bord sur mission complétée).
6. **Banc d'Essai Causal OMA vs AntiGravity** (`src/benchmark/`):
   - Évaluation automatisée et reproductible sur 4 variantes (`vanilla_agy`, `skills_only`, `oma_static_wave`, `oma_dynamic_workflow`).
   - Mesures empiriques réelles : taux de succès sur tests cachés, durée totale, consommation de tokens, défauts interceptés.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---|---|---|---|
| 1 | MoE Capability Resolution | Catalogue des 4 experts (`planner`, `worker`, `reviewer`, `fixer`) et mapping de modèles | M1 | Survey R1 |
| 2 | AntiGravity Headless Driver | Invocation d'`agy` CLI avec arguments contractuels, sandbox et add-dir | M1 | Survey R1 |
| 3 | Process Confinement & Scrubber | Win32 Job Object KillOnJobClose, watchdog timeout et caviardage de clés API | M1 | Survey R1 |
| 4 | Worktree Pool & Isolation | Allocation de worktrees éphémères `.oma/worktrees/` sur branches isolées | M1 | Survey R1 |
| 5 | Parallel Scheduler & Scopes | Ordonnancement parallèle sans collision de scope (`isPathOverlap`) | M1 | Survey R1 |
| 6 | Execution Graph Schema | Schéma strict `ExecutionGraph`, `GraphNode`, `GraphEdge`, rejet des clés superflues | M2 | Survey R2 |
| 7 | Kahn DFS Acyclicity Validator | Validation acyclicité $O(V+E)$ et extraction explicite de cycles DFS 3-couleurs | M2 | Survey R2 |
| 8 | Graph Broker CAS Publication | Publication atomique avec validation de révision (`rev_N.json`, `execution-graph.json`) | M2 | Survey R2 |
| 9 | Deterministic ReadySet Kernel | Calcul pur du readySet selon l'état des nœuds et arêtes | M2 | Survey R2 |
| 10 | Immutability & Anti-Retry | Interdiction stricte de réactivation des nœuds terminaux (`TERMINAL_NODE_MUTATION`) | M2 | Survey R2 |
| 11 | External Objective Judge | Évaluation hermétique sur tests visibles/cachés et production du `ProgressVector` | M3 | Survey R3 |
| 12 | Dynamic Workflow Multi-Wave | Boucle de convergence : vague initiale worker + vagues correctives fixer | M3 | Survey R3 |
| 13 | Lexicographical Monotonicity | Détection de non-progression lexicographique et arrêt fail-closed | M3 | Survey R3 |
| 14 | GraphProposal Mutations | Génération et application formelle de mutations de graphe pour correction | M3 | Survey R3 |
| 15 | SHA-256 Event Journal | Journal `events.jsonl` avec chaînage cryptographique SHA-256 continu | M4 | Survey R4 |
| 16 | Frozen Myers Diffs | Extraction de diffs Myers canoniques et calcul de `sha256(canonicalDiff)` | M4 | Survey R4 |
| 17 | Independent Dual Reviews | Règle stricte $Author \neq Reviewer$ et consensus de revue multi-examinateurs | M4 | Survey R4 |
| 18 | Atomic Git 2PC Promotion | Promotion par `git commit-tree` avec trailer `Oracle-Verdict` et `git merge --ff-only` | M4 | Survey R4 |
| 19 | State Projection from Ledger | Reconstitution déterministe de l'état de mission depuis `events.jsonl` | M5 | Survey R5 |
| 20 | Epoch Fencing & Zombie Recovery | Clôture des runs interrompus et purge des worktrees orphelins | M5 | Survey R5 |
| 21 | Selective Task Resumption | Relance sélective des tâches incomplètes sans rejouer les runs acceptés | M5 | Survey R5 |
| 22 | Resumption Idempotency | Idempotence absolue d'`oma resume` sur mission terminée ou récurrente | M5 | Survey R5 |
| 23 | 4-Variant Benchmark Harness | Exécution comparative de `vanilla_agy`, `skills_only`, `oma_static_wave`, `oma_dynamic_workflow` | M6 | Survey R6 |
| 24 | Hidden Test Evaluation | Mesure objective sur suites cachées hermétiques | M6 | Survey R6 |
| 25 | Empirical Metrics & Reporting | Enregistrement de durée, tokens, succès, défauts, et génération de rapports JSON/Markdown | M6 | Survey R6 |
| 26 | Unified CLI Interface | Commandes `doctor`, `run`, `resume`, `status`, `inspect`, `benchmark`, `plugin install-workspace` | M1-M6 | Survey R1-R6 |
| 27 | 100% E2E Acceptance Suite | Validation de bout en bout de toutes les exigences R1 à R6 et durcissement adversarial | Final | Acceptance Criteria |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| M1 | Multi-Expert Runtime & Confinement | R1: CapabilityResolver, AgyDriver, ProcessRunner (Win32 Job Object), WorktreePool, ParallelScheduler | none | DONE |
| M2 | Graph Governance & CAS Broker | R2: Graph schema, Kahn DFS acyclicity, CAS revision publisher, Kernel readySet, Node immutability | M1 | DONE |
| M3 | Dynamic Workflow & Convergence Loop | R3: ObjectiveJudge, DynamicConvergenceEngine, GraphProposal, Corrective Waves (Fixer) | M2 | DONE |
| M4 | Traceability, Dual Reviews & Git 2PC | R4: MissionEventsStore (SHA-256 chain), Myers diffs, AdversarialReviewEngine, Git 2PC promotion | M2, M3 | DONE |
| M5 | Deterministic Mission Resumption | R5: MissionProjectionEngine, MissionResumptionEngine, Epoch fencing, Idempotent `oma resume` | M2, M4 | DONE |
| M6 | Empirical Causal Benchmark | R6: BenchmarkRunner (4 variants), Hidden test suites, Metrics collection, JSON/Markdown reporting | M1-M5 | DONE |
| E2E | E2E Testing Track | Independent opaque-box test suite (Tiers 1-4) covering all features from requirements | parallel with M1-M6 | DONE (285/285 PASS) |
| Final | Final Integration & Adversarial Hardening | Pass 100% E2E test suite + Tier 5 adversarial coverage hardening (Challenger loop) | M1-M6, E2E | DONE (Tier 5 21/21 PASS) |

---

## Interface Contracts

### M1 ↔ M2 (Runtime ↔ Graph Kernel)
- `ParallelScheduler` interroge `projectGraph(graph).readySet` pour obtenir les nœuds prêts à être exécutés.
- `ParallelScheduler` alloue un worktree via `WorktreePool.acquire(node.id)` et exécute la tâche via `AgyDriver.invoke(expert, prompt, worktreePath)`.
- Après exécution, les résultats (`diff`, `stdout`, `exitCode`) sont retournés au graphe.

### M2 ↔ M3 (Graph Broker ↔ Dynamic Convergence)
- `DynamicConvergenceEngine` soumet une `GraphProposal` au `GraphBroker.validateProposal(proposal)` et `applyProposal(proposal)`.
- Si `validateKahnAcyclicity` échoue (`CYCLE_DETECTED`), la proposition est rejetée sans altérer la révision courante.
- Si validée, la révision est incrémentée atomiquement et l'événement `revision_published` est enregistré dans `events.jsonl`.

### M3 ↔ M4 (Dynamic Convergence ↔ Traceability / Reviews / 2PC)
- Pour chaque run de nœud, `DynamicConvergenceEngine` enregistre `run_started` puis soumet le diff pour revue à `AdversarialReviewEngine`.
- `AdversarialReviewEngine` vérifie que `authorExpertId !== reviewerExpertId` et requiert $\ge 2$ approbations unanimes.
- `DeterministicIntegrator` / `promoteApprovedTransaction` applique le commit Git atomique via `git commit-tree` avec le trailer `Oracle-Verdict: <hash>` et met à jour la branche cible par `git merge --ff-only`.

### M4 ↔ M5 (Traceability Ledger ↔ Resumption Engine)
- `MissionResumptionEngine.resume(missionId)` lit la chaîne complète d'`events.jsonl` via `MissionEventsStore.readEvents()`.
- `MissionEventsStore.verifyEventChain()` vérifie l'intégrité cryptographique SHA-256.
- `MissionProjectionEngine` reconstruit l'état du graphe, identifie les nœuds `succeeded` (préservés), clôture les nœuds `interrupted` sous un nouvel epoch et recalcule le `readySet`.

### M1-M5 ↔ M6 (OMA Engine ↔ Benchmark Runner)
- `BenchmarkRunner` instancie chaque variante (`vanilla_agy`, `skills_only`, `oma_static_wave`, `oma_dynamic_workflow`) avec un budget et un environnement strictement identiques.
- `ObjectiveJudge` évalue le résultat produit sur la suite cachée hermétique `minimal-pipeline-hidden.ts` et produit les métriques comparatives réelles.

---

## Code Layout
```
bin/
├── oma.ts                          # CLI entry point
src/
├── benchmark/
│   ├── benchmark-runner.ts         # Causal benchmark harness (4 variants)
│   └── types.ts                    # Benchmark schemas and result metrics
├── broker/
│   ├── promotion.ts                # Git 2PC atomic promotion
│   └── staging.ts                  # Isolated worktree staging & Myers diff hashing
├── cli/
│   ├── oma-cli.ts                  # Unified CLI dispatcher (doctor, run, resume, etc.)
│   └── __tests__/                  # CLI and stress tests
├── graph/
│   ├── broker.ts                   # GraphBroker, Kahn DFS, CAS publication
│   ├── kernel.ts                   # Pure readySet computation & transition rules
│   ├── model.ts                    # ExecutionGraph, GraphNode, GraphEdge schemas
│   ├── proposal.ts                 # GraphProposal parser & digest calculation
│   └── __tests__/                  # Unit and integration tests for graph
├── ledger/
│   ├── hash-chain.ts               # SHA-256 cryptographic chain
│   ├── mission-events.ts           # MissionEventsStore & authoritative ledger
│   ├── mission-journal.ts          # MissionJournal policy enforcement
│   └── __tests__/                  # Ledger integrity tests
├── oracle/
│   ├── adversarial-review.ts       # Independent dual reviews (Author != Reviewer)
│   ├── executor.ts                 # Isolated gate execution & WeakMap approvals
│   ├── objective-judge.ts          # External objective judge & ProgressVector
│   ├── hidden-tests/               # Hermetic hidden acceptance test suites
│   └── __tests__/                  # Oracle & review tests
├── orchestration/
│   ├── dynamic-engine.ts           # Dynamic Convergence Engine (multi-wave loop)
│   ├── integrator.ts               # Deterministic Git integrator
│   ├── mission-resumption.ts       # Mission Resumption Engine & idempotency
│   ├── scheduler.ts                # Parallel scheduler & scope locking
│   └── worktree-pool.ts            # Git worktree pool & cleanup
├── runtime/
│   ├── agy-driver.ts               # Headless AntiGravity driver
│   ├── capability-resolver.ts      # MoE expert catalogue & model resolution
│   ├── process-runner.ts           # Win32 Job Object & process isolation
│   ├── secret-scrubber.ts          # Secret scrubber & sanitizer
│   └── __tests__/                  # Driver & runtime tests
├── resume/
│   └── engine.ts                   # Low-level crash recovery & epoch fencing
├── packaging/
│   └── install.ts                  # Workspace plugin installer
└── __tests__/                      # Phase 0 to Phase 7 E2E and integration tests
```
