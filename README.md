# Oh My Antigravity (OMA)

Oh My Antigravity (OMA) est un moteur d'orchestration multi-agent et un système de Graph Engineering pour **Google AntiGravity (AGY)**, combinant exécution MoE parallèle, révision adversariale stricte, juge objectif centralisé et convergence dynamique par graphe.

---

## 🎯 Principes Fondamentaux & Architecture

1. **Gouvernance Événementielle & Journal Unique (`events.jsonl`)** :
   - Le journal `events.jsonl` est la source de vérité autoritaire unique et append-only.
   - Les événements sont chaînés cryptographiquement par SHA-256 (`eventHash`, `previousEventHash`).
   - Le graphe d'exécution et l'état de la mission sont projetés de façon pure et idempotente depuis le journal.

2. **MoE Spécialisé & Résolution de Capacités** :
   - Personas minimaux configurés : `planner` (high effort), `worker` (medium effort), `reviewer` (low effort, adversarial), `fixer`.
   - Modèles résolus : `gemini-3.7-flash` ou `gemini-3.7-pro` avec isolation de sandbox et restriction d'outils.

3. **Double Révision Adversariale Indépendante** :
   - Chaque diff produit par un worker est évalué isolément par 2 reviewers indépendants (`reviewer-alpha` et `reviewer-beta`) avec des `runId` distincts.
   - Les reviewers ne voient ni le raisonnement du worker ni le verdict de l'autre reviewer.
   - Aucune auto-certification : la promotion d'un WorkItem exige l'attestation unanime des deux reviewers.

4. **Juge Objectif Centralisé & Suite Cachée** :
   - Évalue la composition globale (`PipelineModuleBundle`) en sub-second.
   - Intègre une suite de tests cachés (hors de portée des agents) pour empêcher les faux succès.
   - Calcule le vecteur de progrès normatif `ProgressVector` :
     $$\text{ProgressVector} = \langle \text{hiddenTestsFailing}, \text{gateFailures}, \text{openDiagnosticsCount}, \text{acceptedWorkItems} \rangle$$
   - Compare la progression de façon lexicographique stricte et monotone.

5. **Dynamic Workflow (`converge-v1`)** :
   - Boucle de convergence adaptative : `discover` $\rightarrow$ `parallel(implement)` $\rightarrow$ `parallel(review)` $\rightarrow$ `fix` $\rightarrow$ `judge` $\rightarrow$ `converge`.
   - Les diagnostics structurés du juge dérivent dynamiquement la vague suivante.
   - Arrêt déterministe en cas de non-progrès après 2 vagues (`no_progress_blocked`) ou dépassement de budget (`budget_exhausted`).

6. **Intégration Déterministe & Pas d'Auto-Merge** :
   - Tri lexicographique par identifiant canonique `workItemId`.
   - Détection stricte des conflits de fichiers : tout chevauchement de portée produit un `Blocker`, jamais un auto-merge hasardeux.
   - Exactement une intégration atomique finale (un seul commit hash produit).

7. **Interruption & Reprise Robuste (`oma resume`)** :
   - Reprise déterministe à partir de `events.jsonl` et des artefacts gelés sur disque.
   - Les runs zombies interrompus sont marqués `interrupted` ; de nouvelles tentatives explicites sont créées sans jamais réexécuter les runs réussis.

---

## 🚀 Commandes CLI OMA

```powershell
# Diagnostic de l'environnement Antigravity et des exécutables
oma doctor

# Installer le plugin OMA dans le workspace actif
oma plugin install-workspace

# Consulter l'état complet en temps réel (JSON ou formatté)
oma status --json
oma status --mission <mission-id>

# Inspecter l'arbre de provenance cryptographique, artefacts et attestations
oma inspect --mission <mission-id>

# Reprendre une mission interrompue
oma resume --mission <mission-id>
```

---

## 🧪 Benchmark Causal à 4 Variantes (Phase 6)

L'implémentation est validée par un benchmark causal automatisé et apparié sur la fixture minimale (`test-fixtures/minimal-pipeline/`) :

| Variante | Taux de Succès aux Tests Cachés | Faux Succès Détectés | Rôle / Comportement Causal |
| :--- | :---: | :---: | :--- |
| **`vanilla_agy`** | **0%** | **100% (Faux succès)** | L'agent sans garde-fous produit un mutant passant les tests visibles mais échouant les tests cachés. |
| **`skills_only`** | **0%** | **100% (Faux succès)** | Le prompt seul sans hook strict ni broker laisse fuiter les cas limites. |
| **`oma_static_wave`** | **0%** | **0% (Interception)** | La double review et le juge interceptent le défaut au gate. 0 promotion non vérifiée. |
| **`oma_dynamic_workflow`** | **100%** | **0% (Convergence)** | Vague 1 intercepte le défaut, Vague 2 dérive un correctif ciblé et converge vers 100% de succès. |

---

## 🛠️ Validation de la Suite de Tests

```powershell
# Compilation TypeScript
bun x tsc

# Exécution de l'ensemble des 8 suites de tests de gate (58 tests passants à 100%)
bun test
```
