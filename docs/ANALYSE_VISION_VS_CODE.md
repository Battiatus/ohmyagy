# Analyse de fond — Vision produit vs code réel (OMA)

**Objet** : confronter, élément par élément, la vision produit à ce que le code fait *réellement*, preuves à l'appui. Pas de survol : chaque écart est tracé au fichier:ligne.

**Méthode** : lecture du moteur (`src/graph`, `src/orchestration`, `src/runtime`), du plan MCP (`src/mcp`), du plugin (`.agents/plugins/oma`), et grep de couverture (qui écrit dans le brain, qui dispatche les agents, où vivent les garanties).

---

## Synthèse en une phrase

Le code contient **deux orchestrateurs distincts** : un moteur *ingénieré* (convergence, détection de blocage, vagues, CAS, ledger) qui tourne **en sous-processus détaché**, et un conducteur *session-native* (skill = prose LLM sur des primitives graphe) qui **n'a aucune de ces garanties**. La vision exige les deux **en même temps**. Aucun des deux chemins ne satisfait seul la vision, et le « cerveau » qu'on croyait rempli était **vide** jusqu'à cette semaine.

---

## Tableau de confrontation (12 éléments de la vision)

| # | Élément de la vision | Réalité code (preuve) | Verdict |
|---|---|---|---|
| 1 | Session active orchestre pour éviter la corruption entre runs | CAS + verrou exclusif + epoch + hash-chaining dans `GraphBroker` (`src/graph/broker.ts:372,403,412,666` `withExclusiveLockSync`, `CAS_CONFLICT`). Robuste **au niveau graphe**. Le brain SQLite n'a pas de contrôle de concurrence inter-sessions (SQLite lock seulement). | ⚠️ Partiel : corruption graphe évitée ; corruption mémoire non gouvernée |
| 2 | Initialiser OMA à tout moment via la commande | `/oma:start` ajouté cette semaine → skill conductrice in-session. Avant : seul `/oma:run` (détaché) existait. | ✅ (nouveau) |
| 3 | Récupère **toute** l'historique de la conversation + contexte, boucle sur les nœuds | Même session : le LLM a le contexte nativement. **Nouvelle session : seuls des RÉSUMÉS existent** — le transcript intégral n'est jamais persisté. « toute l'historique » est faux hors-session. | 🔴 Limite structurelle non dite |
| 4 | Intégré à la session + rappelable d'une nouvelle session sans perdre contexte ni suivi | Graphe reprenable via ledger (`resume`). Mémoire interrogeable via `brain_query`. MAIS (a) brain vide jusqu'à cette semaine, (b) transcript non persisté, (c) un run *session-native* écrit dans `.oma/graph` alors que `/oma:status` lit `.oma/missions` → **un run conduit en session n'apparaît pas dans le suivi mission**. | 🔴 Suivi cross-session incohérent |
| 5 | Invocation non liée à un agent ; l'utilisateur peut appeler un agent directement | `/oma:start` = commande/skill, pas un agent. ✅ Mais « appeler un agent directement » : atlas/metis/themis/sisyphus = **0 référence code**, ce sont des `.md` morts non dispatchés par le runtime. | ⚠️ Moitié vraie |
| 6 | OMA décortique la conversation/contexte/historique du projet, **déjà disponible dans la DB splittée par projet/session et correctement enregistrée** | `grep` des écrivains du brain : **RIEN n'écrivait dans le brain** hors le résumeur ajouté cette semaine (`storeMemory`/`recordInteraction` : 0 appelant en dehors des nouveaux fichiers). Le schéma existait (Étape 1), la DB était **vide**. | 🔴 Prémisse fausse : « correctement enregistré » ne l'était pas |
| 7 | Pose des questions avant de lancer | Skill `oma-start` Step 2 (`ask_question`) — **conditionnel** (« si ambiguïté »), pure prose, non contraint. | ⚠️ Instruction, pas mécanique |
| 8 | Choisit les bons agents/sous-agents **selon le besoin** (debug/fix/feature/gestion projet/infra) | `CapabilityResolver.CORE_EXPERTS` = **4 experts seulement** (planner/worker/reviewer/fixer). Aucune tâche « infra » ni « gestion de projet ». **Aucune fonction ne route un besoin → agent** ; `taskKinds` déclarés mais jamais consommés. Le routage repose sur le jugement du LLM planner. | 🔴 Routage « selon le besoin » inexistant en dur |
| 9 | Pas d'agents au-delà du besoin ; **6 rôles** (orchestrator/planner/explorer/executor/reviewer/verifier) | **Trois taxonomies incohérentes** : (a) enum `ExpertSpec.role` = planner/explorer/worker/reviewer/fixer/verifier ; (b) `CORE_EXPERTS` réellement définis = planner/worker/reviewer/fixer (4) ; (c) 12 fichiers `.md` (atlas/benchmark/fixer/forensic/metis/planner/prometheus/repairer/reviewer/sisyphus/themis/worker). **Aucune** n'égale les 6 rôles de la vision. 7 des 12 `.md` ont 0 référence code. | 🔴 Chaos taxonomique |
| 10 | **Chaque** interaction/échange/**run** enregistré après reformulation par un mini-agent Gemini Flash « toujours dessus » | Résumeur Flash construit cette semaine (hook `Stop`, `src/brain/summarizer*`). Capture les **tours de chat**. MAIS : les **runs détachés** (`RealMissionExecutor`) n'écrivent **rien** dans le brain (0 lien run→brain). Granularité = tour, pas sous-agent. Reformulateur Flash non validé contre un vrai binaire `agy`. | ⚠️ Partiel (nouveau), « toujours » non tenu pour les runs |
| 11 | Petite DB, concept claude-mem (sans utiliser claude-mem) | Résumeur stocke des résumés compacts + mémoires sélectives. Fit raisonnable. Pas de compaction/dédup dans le temps (claude-mem élague ; ici non). | ⚠️ Concept ok, cycle de vie absent |
| 12a | Obligation : gestion des agents via **dynamic workflow** | `graph_propose` + skill `dynamic-workflow` + `GraphProposal` CAS. | ✅ Niveau outil |
| 12b | Obligation : gestion process+agents **et mémoire via graph engineering** | La logique *ingénierée* (convergence, blocage, vagues) vit dans `dynamic-engine.ts` (`maxConsecutiveNoProgressRounds`, `no_progress_blocked`, `progressHistory`) et `RealMissionExecutor` — **appelés uniquement par le chemin détaché** (`oma-cli.ts:268`, `benchmark-runner.ts:224`). Les outils `graph_*` **ne sont pas câblés** à `dynamic-engine`. Le conducteur session-native n'a **aucun** de ces termes (prose pure). | 🔴 Le session-native contourne le graph engineering ingénieré |

---

## Le cœur du problème : deux orchestrateurs, jamais réunis

### Orchestrateur A — ingénieré, mais détaché (le « fantôme »)
`RealMissionExecutor.execute()` (`src/orchestration/real-mission.ts`) + `DynamicConvergenceEngine` (`src/orchestration/dynamic-engine.ts`) :
- boucle par vagues (`maxWaves`), injection de nœuds de réparation (`publishRepairNodes`) ;
- **détection de blocage** (`maxConsecutiveNoProgressRounds: 2` → `no_progress_blocked`) ;
- **vecteurs de progrès** (`progressHistory`, `finalProgress`) ;
- CAS graphe (`GraphBroker`), ledger hash-chaîné.
→ Tourne dans un **sous-processus détaché** lancé par `/oma:run`. Ne reçoit qu'une string `goal`, aucun contexte conversationnel, n'écrit **rien** dans le brain.

### Orchestrateur B — session-native, mais improvisé
Skill `oma-start` = **prose LLM** qui appelle les primitives `graph_init/propose/apply/ready_nodes/mark_node/inspect` :
- tourne **dans la session** (inherite le contexte) ✅ ;
- MAIS **aucune** garantie ingénierée : pas de détection de blocage contrainte, pas de vecteur de progrès, pas d'ordonnanceur de vagues, pas d'injection de réparation. Le LLM improvise la convergence.

### Ce que ça implique
Rendre OMA « session-native » via la skill (ce que j'ai fait cette semaine) **échange les garanties d'ingénierie contre l'intégration de session**. La vision exige **les deux** (élément 1 + obligation 12b). Or les outils `graph_*` livrés sont des **primitives brutes**, pas le **moteur de convergence exposé comme outils**. Le conducteur a des briques de graphe mais pas le « cerveau d'orchestration ».

**La vraie tâche n'est pas « ajouter une commande + un hook ». C'est : faire tourner le moteur de convergence *dans* la session.** Deux voies :
- **(i)** Exposer la logique de `DynamicConvergenceEngine` comme outils MCP déterministes : un `graph_converge_step` / `graph_next_wave` qui exécute *un* pas (calcule le readySet, le vecteur de progrès, le verdict de blocage) et rend la main au conducteur. Le LLM pilote, le moteur décide de la convergence/du blocage.
- **(ii)** Refactorer `RealMissionExecutor` pour être piloté pas-à-pas par la session (chaque vague = un appel MCP) au lieu de boucler en sous-processus.

---

## Réalités à corriger dans la représentation mentale du produit

1. **Le brain était vide.** Le schéma existait, mais aucun code ne l'alimentait avant le résumeur de cette semaine. « OMA se souvient déjà » était faux.
2. **Le panthéon d'agents est décoratif.** atlas/metis/themis/sisyphus/forensic/prometheus/repairer = `.md` sans câblage. Le runtime ne dispatche réellement que des rôles génériques (`worker`, + specs planner/reviewer/fixer). La skill demande « dispatch sisyphus/metis/themis » que le résolveur ne connaît pas (fallback worker).
3. **« Session-native » actuel ≠ moteur ingénieré.** Le chemin session-native n'utilise pas dynamic-engine ; il ré-improvise l'orchestration.
4. **Le suivi est scindé.** `.oma/missions` (chemin détaché) vs `.oma/graph` (primitives session). `/oma:status` ne voit pas un run conduit en session.

---

## Ce que « vraiment session-native, fidèle à la vision » exige (ordre de valeur)

1. **Unifier l'orchestration** : exposer le moteur de convergence (blocage, progrès, vagues, réparation) comme outils MCP pilotables en session — pas des primitives nues. C'est l'écart 12b, le plus structurant.
2. **Alimenter le brain depuis TOUT** : brancher `RealMissionExecutor` **et** le conducteur session-native sur `brain_summarize`/le résumeur, pour que « toujours dessus » vaille aussi pour les runs. Relier le ledger de mission → brain.
3. **Un routage « selon le besoin »** : une fonction (ou une table) qui mappe debug/fix/feature/infra/PM → rôle+modèle, consommant les `taskKinds`. Aujourd'hui absent.
4. **Réconcilier la taxonomie d'agents** sur les 6 rôles réels de la vision, retirer les `.md` morts, aligner la skill sur des noms que le résolveur connaît.
5. **Unifier le suivi** : `/oma:status`/`list`/`inspect` doivent voir les runs session-native (même modèle d'état).
6. **Cycle de vie mémoire** (claude-mem) : compaction/élagage pour que la DB reste petite.

---

## Honnêteté sur mes passes précédentes

J'ai livré « session-native ✅ » trop vite. C'est faux au sens fort : j'ai rendu la skill *atteignable* et ajouté la capture mémoire, mais le chemin session-native **ne porte pas encore les garanties d'ingénierie** que la vision réclame (obligation 12b). Le travail réel restant est l'**unification des deux orchestrateurs**, pas du câblage de surface.
