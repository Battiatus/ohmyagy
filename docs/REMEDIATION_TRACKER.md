# OMA Remediation Tracker & Multi-Session Execution Plan

> **État global :** ✅ Phases 1, 2, 3 et 4 100% VALIDÉES  
> **Dernière mise à jour :** 2026-09-07  
> **Objectif :** Rendre OMA 100% opérationnel, totalement transparent (fin définitive de la boîte noire) et authentiquement intégré dans AntiGravity IDE / CLI.

---

## Guide de Reprise pour les Sessions Futures

Si une nouvelle session démarre :
1. Consulter ce fichier (`docs/REMEDIATION_TRACKER.md`) pour l'état récapitulatif certifié.
2. Exécuter `git status` et `bun test` pour vérifier l'état du code.
3. Toutes les phases de remédiation P0/P1 sont achevées avec succès et validées par des tests sans simulation.

---

## Vue d'Ensemble des Phases

| Phase | Intitulé | Priorité | Statut |
| :--- | :--- | :---: | :---: |
| **Phase 1** | **Déblocage Technique Immédiat & Hygiène Git** | **P0** | **✅ 100% VALIDÉ** |
| **Phase 2** | **Fin de la Boîte Noire (Observabilité, Streaming & Logs Réels)** | **P0** | **✅ 100% VALIDÉ** |
| **Phase 3** | **Intégration Authentique AntiGravity (Serveur MCP & CLI)** | **P1** | **✅ 100% VALIDÉ** |
| **Phase 4** | **Assainissement de la Revue Adversariale & Benchmark Réel** | **P1** | **✅ 100% VALIDÉ** |

---

## Détail des Tâches et Avancement

### Phase 1 : Déblocage Technique Immédiat & Hygiène Git (P0)
*Objectif : Rendre le dépôt propre, supprimer les chemins en dur, et faire passer 100% des tests.*

- [x] **Tâche 1.1 : Hygiène Git & Exclusion des répertoires de build**
  - [x] Ajout de `dist/`, `coverage/`, `*.log` à `.gitignore`.
  - [x] Exclusion git pathspec des fichiers d'artefacts dans `ensureCleanWorkspace()`.
  - [x] Suppression des commits vides automatiques (`--allow-empty`) dans `src/orchestration/dynamic-engine.ts:551-580` avec vérification de `git status --porcelain`.
- [x] **Tâche 1.2 : Assouplissement de `ensureCleanWorkspace`**
  - [x] Introduction de `--allow-dirty` / `-f` / `allowDirty: true` dans `src/orchestration/real-mission.ts` et `src/cli/oma-cli.ts`.
  - [x] Permet à `oma run` et `oma start` de s'exécuter en environnement de développement sans blocage circulaire.
- [x] **Tâche 1.3 : Élimination des chemins en dur Windows**
  - [x] Remplacement de `C:\nvm4w\nodejs\node.exe` dans `.agents/plugins/oma/gates.json` et `mcp_config.json` par `node` / `bun` portables.
- [x] **Tâche 1.4 : Réparation des tests unitaires et E2E**
  - [x] Alignement de `src/runtime/capability-resolver.ts` avec la suite Tier 1 (`gemini-3.7-pro` / `gemini-3.7-flash`).
  - [x] Correction de la condition d'arrêt dans `src/orchestration/dynamic-engine.ts` pour gérer les travaux initiaux sans épuisement prématuré du budget.
  - [x] Suites Tier 1 (45/45), Tier 2 (45/45) et Tier 3 (10/10) exécutées et validées à 100% PASS.
- [x] **Tâche 1.5 : Compilation TypeScript sans erreur**
  - [x] Correction des types TypeScript et élimination des opérateurs `??` redondants dans `src/runtime/agy-driver.ts` et `src/orchestration/dynamic-engine.ts`.
  - [x] Compilation `bun run build` (`tsc`) réussie avec code de retour 0.

---

### Phase 2 : Fin de la Boîte Noire (Observabilité, Streaming & Logs Réels) (P0)
*Objectif : Permettre à l'utilisateur de voir les agents travailler en direct, comprendre les erreurs et déboguer.*

- [x] **Tâche 2.1 : Streaming console en direct (Live TTY Streaming)**
  - [x] Transmission en temps réel des flux stdout/stderr dans `src/runtime/process-runner.ts` et `src/runtime/agy-driver.ts` via `onStdoutChunk` et `streamToConsole`.
  - [x] Badges visuels explicites pour chaque persona : `[OMA:Planner]`, `[OMA:Worker:<id>]`, `[OMA:Reviewer:<expert>]`, `[OMA:Gate:<id>]`, `[OMA:Integrator]`, `[OMA:Mission]`.
- [x] **Tâche 2.2 : Journalisation lisible par un humain (`mission.log` & `runs/`)**
  - [x] Module dédié `src/logging/mission-logger.ts` instanciant `MissionLogger` et `RunLogger`.
  - [x] Création automatique de l'arborescence `.oma/missions/<missionId>/` :
    - `mission.log` : journal chronologique lisible de la mission.
    - `runs/<runId>.log` : prompt contractuel complet, sortie brute d'inférence, flux parsé, métriques et statut.
    - `diffs/<workItemId>.patch` : diffs Git unifiés réels prêts pour l'inspection.
    - `gate-logs/<gateId>.log` : logs complets d'exécution des gates de conformité.
- [x] **Tâche 2.3 : Mode verbeux & Inspection CLI enrichie**
  - [x] Ajout de `-v` / `--verbose` à `oma run` et `oma resume`.
  - [x] Enrichissement interactif de `oma inspect` :
    - `oma inspect --diff [nodeId]` : visualisation du patch unifié.
    - `oma inspect --runs` : tableau des runs d'agents avec taille et statut.
    - `oma inspect --log <runId>` : affichage de la transcription complète d'un run.
    - `oma inspect --gates` : détails diagnostiques et causes d'échecs de tests.
  - [x] Validation unitaire : `src/logging/__tests__/mission-logger.test.ts` (100% PASS).

---

### Phase 3 : Intégration Authentique AntiGravity (Serveur MCP & CLI) (P1)
*Objectif : Rendre OMA réellement découvrable et utilisable depuis l'IDE AntiGravity et le chat.*

- [x] **Tâche 3.1 : Déclaration et validation formelle du serveur MCP `oma-broker`**
  - [x] Validation du serveur MCP stdio en sous-processus via protocole JSON-RPC (méthodes `initialize` et `tools/list` confirmées conformes aux specs MCP 2024-11-05).
  - [x] Portabilité `node` / `bun` dans `src/packaging/install.ts` et `.agents/plugins/oma/mcp_config.json`.
- [x] **Tâche 3.2 : Normalisation des arguments `AgyDriver`**
  - [x] Ajout du support de `--agent` contrôlé via l'option `preserveAgent` et la variable d'environnement `OMA_PRESERVE_AGENT=true` pour préserver le ciblage MoE lors des invocations CLI.

---

### Phase 4 : Assainissement de la Revue Adversariale & Benchmark Réel (P1/P2)
*Objectif : Remplacer le théâtre de code par de vraies revues et de vraies mesures.*

- [x] **Tâche 4.1 : Suppression de `hasMutant` et vraie revue de diff**
  - [x] Élimination du filtre par motif statique `hasMutant` dans `src/orchestration/dynamic-engine.ts:456-525`.
  - [x] Transmission du patch complet au reviewer et évaluation dynamique du verdict structuré (`verdict: "approved"`).
- [x] **Tâche 4.2 : Moteur de Benchmark Causal Réel**
  - [x] Remplacement du benchmark simulé par `src/benchmark/real-benchmark.ts`.
  - [x] Exécution empirique des 4 variantes (`vanilla_agy`, `skills_only`, `oma_static_wave`, `oma_dynamic_workflow`) sur worktrees Git isolés avec rétention de preuves SHA-256.
  - [x] Suite de tests `src/benchmark/__tests__/real-benchmark.test.ts` validée (100% PASS sur 12 essais).

---

## Journal de Bord des Sessions

### Session 1 — 2026-09-07
- Audit contradictoire initial réalisé via Teamwork (rapport dans `.agents/orchestrator_7/AUDIT_REPORT.md`).
- Validation par l'utilisateur des 3 priorités : 1) Déblocage et exécution réelle, 2) Fin de la boîte noire / streaming & logs, 3) Intégration authentique dans AntiGravity.
- Création du système de suivi `docs/REMEDIATION_TRACKER.md`.
- Réalisation et validation complète des Phases 1, 2, 3 et 4 :
  - Hygiène Git et exclusion des artefacts.
  - Streaming TTY temps réel et arborescence de logs lisibles.
  - Serveur MCP stdio 100% fonctionnel.
  - Suppression des mocks `hasMutant` et benchmark causal réel.
  - Compilation `tsc` sans erreur (exit code 0).
