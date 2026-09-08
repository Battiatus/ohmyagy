# Spécification Technique — OMA Approche A : Orchestrateur Session-Native & Cerveau Neuronal

**Statut** : Approuvé (Prêt pour implémentation par agent)  
**Labels** : `ready-for-agent`, `architecture`, `oma-v2`  
**Auteurs** : kronos Agent (Ayaros Technology)  
**Date** : 8 Septembre 2026  

---

## Problem Statement

Oh My Antigravity (OMA) a été conçu à l'origine avec un modèle d'exécution hybride où une CLI externe lançait des processus « fantômes » en arrière-plan via des sous-processus `agy` headless (`real-mission.ts`). Cette approche crée plusieurs ruptures critiques :

1. **Rupture de session et désynchronisation** : Les exécutions headless échappent au contexte conversationnel de la session active d'Antigravity IDE. L'utilisateur ne peut pas injecter de clarifications en cours de route, et l'agent actif ne contrôle pas directement la progression du graphe.
2. **Perte de mémoire et hallucinations répétées** : OMA ne dispose pas d'une mémoire persistante segmentée par projet et par session. Chaque session repart de zéro ou s'appuie sur des logs de texte bruts verbeux, provoquant l'oubli des choix architecturaux passés, la répétition d'erreurs déjà commises, et la saturation du contexte.
3. **Rigidité des workflows** : Les flux d'exécution risquent d'être figés dans du code impératif ou cantonnés à certaines technologies spécifiques, alors que les LLMs de pointe doivent être capables de formuler dynamiquement des DAGs adaptés à n'importe quel langage (Python, TypeScript, Rust, Go, C++, C#...).
4. **Absence de phase d'alignement interactif** : L'orchestrateur sautait directement dans l'exécution sans décortiquer au préalable l'historique de la conversation, analyser le contexte du projet et poser des questions ciblées pour valider les intentions de l'utilisateur.

---

## Solution

L'**Approche A (« Réécriture Chirurgicale »)** transforme OMA en un orchestrateur **session-native** d'inspiration Oh My Codex / Oh My Claude, parfaitement intégré dans l'environnement Antigravity sans processus fantôme.

Le système s'articule autour d'une séparation stricte et élégante des responsabilités :

1. **Le Serveur MCP = Le Moteur (The Motor)** :
   - Maintient l'état canonique, la topologie du DAG et le graphe d'exécution via le `GraphKernel` et le `GraphBroker`.
   - Garantit l'intégrité cryptographique via le ledger d'événements chaînés (`events.jsonl`).
   - Fournit un **Cerveau Neuronal (Neural Brain SQLite)** local, zéro-dépendance (via `node:sqlite`), compartimenté par projet et par session.
   - Stocke 5 dimensions clés : choix architecturaux, erreurs passées, résumés de runs, contexte de projet, et préférences utilisateur.
   - Expose une suite d'outils MCP idempotents pour piloter le graphe, interroger la mémoire et valider les portes de qualité.

2. **Les Skills Antigravity = Le Conducteur (The Driver)** :
   - S'exécutent au sein même de la **session active** de l'IDE Antigravity.
   - Pilotent la boucle de rétroaction : analyse du contexte -> alignement interactif avec l'utilisateur -> proposition de DAG par le planner -> dispatch des sous-agents natifs Antigravity -> validation par les reviewers/verifiers -> promotion atomique.
   - Orchestrent la mémoire : déclenchent un mini-agent résumeur (modèle compact/rapide type Flash) pour compacter et persister chaque interaction dans le Brain.
   - Permettent à n'importe quelle nouvelle session d'invoquer OMA, de recharger l'état du Brain et de reprendre le travail sans aucune perte de continuité.

3. **Indépendance Technologique Totale** :
   - OMA opère sur des projets vides, naissants ou matures, quel que soit l'écosystème technique (Python, JS/TS, Rust, C++, C#, etc.).
   - Le modèle de langage formule les workflows sous forme de propositions dynamiques (`GraphProposal`), tandis qu'OMA fournit le cadre d'exécution, la validation par portes (gates) et la garantie anti-hallucination.

---

## User Stories

### Initialisation & Alignement Interactif
1. **As a developer**, I want to invoke OMA at any point in an ongoing conversation with `/oma-start`, so that OMA inherits the full conversation history without restarting my session.
2. **As a developer**, I want OMA to analyze existing conversation transcripts and project files before doing anything, so that it gains deep context without me repeating instructions.
3. **As a developer**, I want OMA to ask targeted clarifying questions before locking down an execution plan, so that we agree on architecture and constraints beforehand.
4. **As a developer**, I want OMA to work seamlessly on a completely blank repository, so that I can scaffold new projects with zero initial boilerplate.
5. **As a developer**, I want OMA to work on legacy or mature multi-language repositories, so that existing codebase conventions are strictly discovered and respected.

### Cerveau Neuronal & Mémoire Persistante (SQLite Brain)
6. **As an agent**, I want the MCP server to provide a SQLite-backed Brain segmented by `projectId` and `sessionId`, so that project memories remain isolated and coherent across multiple initiatives.
7. **As an agent**, I want to store architectural decisions into the Brain, so that subsequent tasks never contradict established system designs.
8. **As an agent**, I want to record past build, test, and lint failures into the Brain, so that I never repeat an approach that previously failed.
9. **As an agent**, I want to record user preferences (coding style, conventions, preferred libraries) into the Brain, so that code generation automatically matches developer taste.
10. **As an orchestrator**, I want a background summarization routine to compress action logs into high-density memory entries, so that future context retrieval consumes minimal tokens.
11. **As a developer starting a fresh session**, I want OMA to query the Brain for past session context, so that I can resume a complex multi-day mission without re-explaining background information.
12. **As an auditor**, I want to inspect all memory items stored in the Brain via MCP query tools, so that the AI's internal belief state remains transparent and debuggable.

### Gestion du Graphe d'Exécution & Workflow Dynamique
13. **As the planner agent**, I want to formulate a `GraphProposal` defining tasks, dependencies, quality gates, and expected artifacts, so that complex objectives are decomposed into an executable DAG.
14. **As the orchestrator skill**, I want to query the MCP server for ready nodes whose dependencies are satisfied, so that independent work items can be scheduled concurrently.
15. **As the orchestrator skill**, I want to dispatch native Antigravity subagents (`sisyphus`, `metis`, `themis`) on specific ready nodes, so that work is executed with least-privilege tools.
16. **As a worker agent**, I want to propose staged file changes through the MCP broker, so that my edits are verified in an isolated worktree before touching HEAD.
17. **As an orchestrator skill**, I want dynamically failing gates to trigger dynamic replanning waves in the DAG, so that defects are resolved iteratively without aborting the entire mission.
18. **As an orchestrator skill**, I want to detect progress deadlocks (two consecutive rounds with zero progress), so that execution halts safely with an actionable diagnosis instead of looping indefinitely.

### Intégrité & Preuve Cryptographique
19. **As a verifier agent (themis)**, I want to execute deterministic quality gates and record signed verdicts in the ledger, so that no worker can self-certify its own code.
20. **As a reviewer agent (metis)**, I want to attest a staged diff before promotion, so that security, style, and correctness invariants are enforced independently.
21. **As the MCP broker**, I want every state transition, run, and review to be appended to `events.jsonl` with SHA-256 hash chaining, so that mission provenance is tamper-evident.
22. **As a developer**, I want to run `oma inspect` or call `mission_inspect` via MCP, so that I can see the cryptographic chain of custody for every file modified.

### Résilience, Reprise & Multi-Session
23. **As a developer**, I want OMA state to survive an IDE crash, process kill, or machine reboot, so that I never lose work.
24. **As an orchestrator skill**, I want to invoke `graph_resume` or `resume_mission` to reconstruct the exact DAG state from `events.jsonl` and SQLite, so that completed work items are never re-executed.
25. **As a developer**, I want to switch from one AI model to another (e.g. from Claude Opus to Gemini Flash) mid-project, while OMA maintains consistent orchestration and memory.

---

## Implementation Decisions

### 1. Découpage Modulaire et Rôles

```
+-------------------------------------------------------------+
|                      Antigravity Session                    |
|                                                             |
|  +-------------------------------------------------------+  |
|  |             OMA Orchestrator Skill (Conductor)         |  |
|  | - Context Extraction & Transcript Analysis            |  |
|  | - Interactive User Alignment (ask_question)           |  |
|  | - Native Subagent Dispatch (Planner, Worker, Reviewer)|  |
|  | - Mini-Agent Summarizer (Background Memory Compaction) |  |
|  +---------------------------+---------------------------+  |
|                              | JSON-RPC (MCP)               |
+------------------------------|------------------------------+
                               v
+-------------------------------------------------------------+
|               OMA MCP Broker Server (Motor)                 |
|                                                             |
|  +-----------------------+     +-------------------------+  |
|  |   Graph Engine & DAG  |     |   Neural Brain (SQLite) |  |
|  | - Capabilities Graph  |     | - Project Partitioning  |  |
|  | - Execution DAG       |     | - Session History       |  |
|  | - Provenance Graph    |     | - 5 Memory Dimensions   |  |
|  +-----------+-----------+     +------------+------------+  |
|              |                              |               |
|              +---------------+--------------+               |
|                              v                              |
|  +-------------------------------------------------------+  |
|  |               Ledger & Staging Storage                |  |
|  | - events.jsonl (SHA-256 Hash Chaining)                |  |
|  | - Isolated Git Worktrees & Fast-Forward Promotion     |  |
|  +-------------------------------------------------------+  |
+-------------------------------------------------------------+
```

### 2. Le Moteur SQLite (Neural Brain)

Le Cerveau Neuronal est implémenté avec `node:sqlite` (`DatabaseSync`), natif dans Node.js v22+ et Bun, garantissant zéro dépendance externe et aucune compilation native requise sur Windows.

Emplacement de la base : `.oma/brain.sqlite` (ou global sous `~/.oma/brain.sqlite` pour les liaisons cross-projets).

#### Schéma SQL des Tables Principales :
```sql
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    tech_stack TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    objective TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    dimension TEXT NOT NULL CHECK(dimension IN (
        'architectural_decision',
        'past_error',
        'run_summary',
        'project_context',
        'user_preference'
    )),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT, -- JSON array of tags
    confidence REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    user_intent TEXT,
    actions_taken TEXT,
    outcome TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mem_project_dim ON memory_entries(project_id, dimension);
CREATE INDEX IF NOT EXISTS idx_mem_session ON memory_entries(session_id);
```

### 3. Nouveaux Outils MCP Exposés par `broker-server.ts`

Le serveur MCP enrichit sa liste d'outils pour donner un contrôle programmatique complet aux skills de la session :

1. **`brain_store`** : Enregistre une entrée de mémoire typée (décision, erreur, préférence, etc.).
   ```json
   {
     "projectId": "string",
     "sessionId": "string",
     "dimension": "architectural_decision | past_error | run_summary | project_context | user_preference",
     "title": "string",
     "content": "string",
     "tags": ["string"]
   }
   ```
2. **`brain_query`** : Recherche dans la mémoire par projet, dimension ou mot-clé.
   ```json
   {
     "projectId": "string",
     "dimensions": ["string"],
     "query": "string (optionnel)",
     "limit": 10
   }
   ```
3. **`brain_summarize`** : Enregistre le résumé condensé produit par le mini-agent résumeur après un échange.
4. **`graph_init`** : Initialise un graphe d'exécution pour un objectif donné et retourne l'identifiant de mission.
5. **`graph_propose`** : Soumet une proposition atomique de DAG (`GraphProposal`).
6. **`graph_apply`** : Valide et applique une révision au graphe d'exécution canonique.
7. **`graph_ready_nodes`** : Récupère la liste ordonnée des nœuds prêts à être exécutés (dépendances satisfaites).
8. **`graph_mark_node`** : Met à jour l'état d'un nœud (`running`, `completed`, `failed`, `blocked`) avec preuves associées.
9. **`graph_inspect`** : Retourne l'état complet du graphe avec métriques de progression.

### 4. Réécriture des Skills en « Conducteur » Session-Native

- **`.agents/plugins/oma/skills/oma-start/SKILL.md`** :
  - **Étape 1 (Inspection de contexte)** : Lit l'historique conversationnel de la session active et interroge `brain_query` pour le projet courant.
  - **Étape 2 (Alignement interactif)** : Présente les hypothèses à l'utilisateur via `ask_question` si des ambiguïtés subsistent.
  - **Étape 3 (Initialisation du graphe)** : Appelle `graph_init` sur le MCP.
  - **Étape 4 (Formulation du plan)** : Dispatche l'agent natif `planner` pour générer le `GraphProposal` adapté à la stack découverte.
  - **Étape 5 (Boucle d'exécution native)** :
    - Boucle tant qu'il y a des nœuds prêts (`graph_ready_nodes`).
    - Dispatche les sous-agents (`sisyphus`, `metis`, `themis`).
    - Chaque modification de fichier passe par `propose_change` -> `attest_review` -> portes -> `promote_change`.
  - **Étape 6 (Compaction continue)** : Après chaque lot d'actions, déclenche un résumé condensé stocké dans le Brain via `brain_store`.

---

## Testing Decisions

### Seam Architectural
Le point de couture (seam) unique retenu est **l'interface JSON-RPC du serveur MCP (`broker-server.ts`)** et **l'API TypeScript de la classe `BrainStore`**.
Tout comportement (persistance mémoire, transitions de graphe, vérification de preuves, reprise) est testé via ce point de contact externe, garantissant que les tests ne dépendent pas des détails d'implémentation internes.

### Modules Couverts par les Tests
1. **`src/brain/__tests__/brain-store.test.ts`** :
   - Initialisation et création de tables SQLite avec `node:sqlite`.
   - Isolation stricte entre deux projets différents.
   - Insertion, mise à jour, recherche et suppression par dimension.
   - Gestion des résumés d'interactions et requêtes chronologiques.
2. **`src/mcp/__tests__/brain-tools.test.ts`** :
   - Exécution des requêtes JSON-RPC pour `brain_store`, `brain_query`, et `brain_summarize`.
   - Validation des schémas d'entrée et gestion des erreurs de validation.
3. **`src/mcp/__tests__/graph-tools.test.ts`** :
   - Initialisation d'une mission via `graph_init`.
   - Application d'un `GraphProposal` et lecture des `ready_nodes`.
   - Cycle complet de complétion d'un nœud et progression du DAG.
4. **`src/__tests__/session-native-orchestration.test.ts`** :
   - Test d'intégration de bout en bout simulant le conducteur de session :
     Initialisation -> Alignement -> Proposition de graphe -> Exécution simulée d'un worker -> Attestation -> Promotion -> Enregistrement en Brain.
5. **Non-Régression** :
   - Conservation des 9 suites de tests de phase existantes (`phase0` à `phase7`, stress tests et audit).

---

## Out of Scope

1. **Bases de données vectorielles distantes** : Pas de Pinecone, Qdrant ou Chroma externe. La recherche SQLite intégrée (FTS5 si nécessaire) répond à 100% des besoins locaux sans latence ni dépendance réseau.
2. **Remplacement de l'UI IDE** : OMA n'essaie pas de créer une extension graphique propriétaire. Il s'appuie à 100% sur les capacités natives d'Antigravity (Chat, Skills, Markdown Artifacts, Tools, Subagents).
3. **Moteur démon autonome hors session** : Aucun processus d'arrière-plan permanent ne tourne une fois la session terminée.

---

## Further Notes

### Directives pour l'implémentation par Gemini 3.8 Flash
- L'implémentation doit débuter par le module `src/brain/` avec sa suite de tests unitaires dédiés.
- Ensuite, brancher les handlers dans `src/mcp/broker-server.ts` et enrichir le catalogue d'outils.
- Enfin, adapter les fichiers de skills dans `.agents/plugins/oma/skills/` pour refléter le rôle de conducteur session-native.

---

## Amendement v2 — Recadrages produit (retours Kronos, 8 sept. 2026)

Ces recadrages précisent le scénario nominal et priment sur les hypothèses implicites de la spec d'origine. Le plan d'exécution associé est `docs/PLAN_UNIFICATION_CLEANING.md`.

### Phase 0 — Context Ingestion & User Interview (nouveau, obligatoire)

Le scénario nominal n'est **pas** « lancer une mission d'un bloc dans un terminal vierge ». C'est le **Late-Init** :

1. **Conversation libre d'abord.** L'utilisateur explore, teste, discute dans sa session Antigravity.
2. **Déclenchement à la volée** (`/oma:start`) : l'orchestrateur, exécuté **dans la session**, ingère le contexte :
   - **Ingestion native (primaire)** : le conducteur tourne dans la session active, donc le LLM voit déjà l'historique conversationnel — c'est le mécanisme principal.
   - **Brain (cross-session)** : `brain_query` sur le projet courant pour recharger décisions, erreurs passées, préférences des sessions antérieures.
   - **Transcript de session (secondaire, à vérifier)** : si un journal de session accessible existe, l'ingérer ; sinon s'en passer proprement. *La disponibilité d'un tel fichier n'est pas supposée acquise.*
3. **Sas d'interview obligatoire (bloquant).** Avant d'instancier le moindre graphe, OMA pose des **questions ciblées** (`ask_question`) : périmètre, compromis techniques, critères d'acceptation, et **mode requis** (debug / bugfix / feature / refactor / infra / project-management). **Le run ne démarre pas tant que l'utilisateur n'a pas répondu.**
4. **Sélection de mode → routage.** Le mode retenu sélectionne un sous-ensemble des 6 rôles + une config (voir ci-dessous), via l'outil `plan_route`.

### Taxonomie stricte : 6 rôles, modes-en-config

Les seuls agents dispatchables sont **`orchestrator, planner, explorer, executor, reviewer, verifier`**. Les modes (debug, fix, feature, infra…) sont des **configurations de prompt/skill appliquées à ces rôles**, jamais des agents codés en dur. Tous les autres `.md` (atlas, metis, themis, sisyphus, forensic, prometheus, repairer) sont **retirés/archivés**.

### Schéma de transition mémoire (mini-agent Gemini Flash)

Après chaque échange **et** chaque validation de nœud, un appel **Gemini Flash** (via l'intégration AGY, `modelClass: fast`) reformule l'étape en forme canonique et la persiste :

- **Journal d'interactions** (léger, dense) : `interaction_summaries(id, session_id, round_number, node_ref, context_summary /*= userIntent*/, actions_taken, outcome, created_at)`. Le `node_ref` **relie la mémoire au graphe** (obligation « mémoire via graph engineering »).
- **Mémoires durables** (5 dimensions, conservées) : `memory_entries(...)` pour décisions architecturales, erreurs passées, préférences, contexte projet, résumés de run — pour que les erreurs passées ne soient jamais répétées.

La mémoire reste **petite** (concept claude-mem, sans dépendre de claude-mem) : compaction/élagage périodique (`BrainStore.compact`).

### Garde-fou de séquencement (technique)

Le retrait du chemin détaché (`launchDetachedCli`, `real-mission.ts` en tant que démon) se fait **après** extraction de sa logique de convergence (blocage, progrès, vagues) vers un moteur exposé en outils MCP (`converge_step`) pilotable en session. `dynamic-engine.ts`/`real-mission.ts` sont **conservés comme bibliothèque** ; seul le **lancement détaché** disparaît. Supprimer avant extraction détruirait les garanties d'ingénierie (voir `docs/PLAN_UNIFICATION_CLEANING.md`, G1).
