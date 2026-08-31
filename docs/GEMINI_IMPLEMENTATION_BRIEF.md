# OMA — Brief d’implémentation pour Gemini

## Statut et autorité

Ce document est la consigne de réalisation autoritative pour la prochaine
implémentation d’Oh My Antigravity (OMA).

Il consolide le besoin utilisateur, le cas de référence Anthropic/Bun, le
Graph Engineering déjà esquissé dans le dépôt et l’audit du code livré le
30 août 2026.

En cas de conflit, ce brief remplace pour ce chantier :

- le plan correctif proposé dans la réponse Gemini du 30 août ;
- l’interdiction absolue des boucles dans `README.md` et
  `docs/DYNAMIC_WORKFLOW.md` ;
- les ordres de construction concurrents de `docs/IMPLEMENTATION_PLAN.md` et
  `docs/architecture/ADR-002-orchestration-plane.md`.

Il ne demande pas de réécrire ces documents avant d’avoir obtenu la première
preuve end-to-end. Leur mise à jour viendra après validation de la tranche.

## Instruction courte à donner à Gemini

> Implémente `docs/GEMINI_IMPLEMENTATION_BRIEF.md` dans l’ordre indiqué. Ne
> transforme pas ce brief en nouvelle spécification. Construis d’abord la plus
> petite tranche observable, avec la vraie CLI AntiGravity et sans mock. Ne
> déclare une phase terminée que lorsque sa gate observable est passée.

## 1. Besoin produit

OMA doit être une solution qui s’interface avec AntiGravity et permet, comme
les meilleurs modes d’OhMyClaudeCode, OhMyCodex et OhMyOpenCode, de :

1. lancer des protocoles longs et complexes ;
2. répartir le travail entre des experts spécialisés de type Mixture of
   Experts ;
3. faire évoluer le protocole à partir des résultats réellement observés ;
4. suivre les tâches, Runs, preuves, blocages, coûts et progrès ;
5. empêcher l’auto-certification et vérifier la réalisation effective ;
6. interrompre puis reprendre sans perdre le travail terminé ;
7. comparer causalement OMA à AntiGravity utilisé sans OMA.

Les deux bases technologiques imposées sont :

- **Dynamic Workflow** pour l’orchestration adaptative et la convergence ;
- **Graph Engineering** pour le routage, l’état durable, les dépendances, les
  preuves et l’explicabilité.

## 2. Référence normative : Anthropic et le portage de Bun

Sources primaires :

- <https://code.claude.com/docs/en/workflows>
- <https://claude.com/blog/introducing-dynamic-workflows-in-claude-code>
- <https://claude.com/blog/ai-code-migration>
- <https://bun.com/blog/bun-in-rust>

Le cas Bun n’est pas un DAG statique exécuté par plusieurs agents. Les éléments
ci-dessous décrivent ce cas concret. OMA en retient les propriétés utiles ; il
ne prétend pas reproduire à l’identique le runtime Claude Code.

Il combine :

- un programme de workflow contenant branches, boucles et résultats
  intermédiaires ;
- une préparation en amont : rulebook, dependency map et gap inventory ;
- un essai sur une très petite tranche avant le fan-out massif ;
- des files de travail mécaniques produites par les artefacts, le compilateur,
  les crashes et les tests ;
- un implémenteur, au moins deux reviewers adversariaux dans des contextes
  séparés, puis un fixer ;
- des vagues successives jusqu’au juge vert, au budget épuisé ou à l’absence de
  progrès ;
- une reprise fondée sur les résultats et artefacts déjà persistés ;
- une observation humaine permettant de mettre en pause, corriger puis relancer
  une version identifiée des règles ou du workflow quand le processus produit
  systématiquement de mauvais résultats.

Le starter kit publié par Anthropic est un modèle généralisé, pas le workflow
exact utilisé pour Bun. Il sert de référence, pas de code à recopier.

Le principe transférable à OMA est :

```text
règles + juge objectif
        -> découverte d’une file de travail
        -> fan-out d’experts
        -> revue adversariale
        -> corrections et intégration
        -> compilation / tests / comparaison
        -> nouvelle file issue des résultats
        -> vague suivante ou arrêt explicite
```

## 3. Décision centrale : boucle logique, graphe monotone

Le Dynamic Workflow **doit pouvoir boucler** jusqu’à convergence.

Les retries cachés et les self-loops opaques restent interdits. La boucle est
représentée explicitement par de nouveaux Runs, de nouvelles preuves et, si la
file de travail évolue, une nouvelle révision de graphe.

Exemple :

```text
diagnose_1 -> fix_1 -> review_1 -> gate_1
                                      |
                                      +-- vert --> terminé
                                      +-- rouge --> diagnose_2 -> fix_2 -> ...
                                      +-- aucun progrès / budget --> arrêté
```

Chaque vague publiée est acyclique. L’historique n’est jamais réécrit. La
mission complète peut néanmoins contenir plusieurs vagues de convergence. OMA
matérialise les changements de programme, de règles ou de file comme des
révisions versionnées : c’est son mécanisme de traçabilité, pas une affirmation
sur l’implémentation interne du cas Bun.

Cette décision remplace l’interdit actuel « aucun verify/fix until done ».

## 4. Graph Engineering : différenciation d’OMA

Le Graph Engineering n’est pas une base de données graphe ni un diagramme
décoratif. Il fournit trois projections cohérentes d’un même journal
autoritatif.

### 4.1 Graphe de capacités

Il répond à : « quel expert peut accomplir cette unité, avec quels outils, quel
modèle, quel effort et quelles permissions ? »

Contrat minimal d’un expert :

```ts
interface ExpertSpec {
  id: string;
  role: "planner" | "explorer" | "worker" | "reviewer" | "fixer" | "verifier";
  taskKinds: string[];
  modelClass: "fast" | "balanced" | "frontier";
  effort: "low" | "medium" | "high";
  tools: string[];
  readOnly: boolean;
}
```

Le runtime résout cette demande vers un agent et un modèle réellement
disponibles dans AntiGravity. Copier des fichiers Markdown ne suffit pas.

### 4.2 Graphe de travail

Il répond à : « que reste-t-il à faire, pourquoi et dans quel ordre ? »

Il distingue obligatoirement :

- `Mission` : objectif et conditions terminales ;
- `WorkItem` : unité dont l’identité devient stable après matérialisation ;
- `AgentRun` : tentative d’un expert sur un WorkItem ;
- `Decision` : choix du workflow ou intervention humaine ;
- `Gate` : juge mécanique ;
- `Blocker` : dépendance externe ou arrêt explicite.

Un WorkItem peut avoir plusieurs AgentRuns explicites. Un Run interrompu n’est
jamais remis silencieusement en cours et un WorkItem déjà accepté n’est jamais
réexécuté. La file globale reste dynamique : elle peut découvrir, subdiviser,
superséder ou bloquer des WorkItems à partir des preuves observées.

Relations minimales :

```text
DECOMPOSES_INTO
DEPENDS_ON
ASSIGNED_TO
ATTEMPTS
SUPERSEDES
CONFLICTS_WITH
PRODUCES
VERIFIED_BY
BLOCKED_BY
```

### 4.3 Graphe de preuve et de provenance

Il répond à : « pourquoi considérons-nous ce travail terminé ? »

Chaîne minimale :

```text
WorkItem
  -> AgentRun
  -> Artifact ou Diff
  -> Review et Observation
  -> Verification
  -> Verdict
```

Une sortie JSON, un exit code 0 ou une déclaration du worker sont des `Claim`,
pas des preuves terminales.

Le benchmark réutilise ces événements. Il ne doit pas reconstruire une seconde
télémétrie parallèle.

## 5. Architecture KISS retenue

```text
Mission utilisateur
        |
        v
Workflow Program versionné
  - discover
  - parallel workers
  - adversarial reviews
  - fix
  - judge
  - repeat / stop
        |
        v
Capability Resolver ------> agents / modèles / outils AntiGravity
        |
        v
Work Graph + queue durable
        |
        v
agy.exe dans des worktrees isolés par shard ou Run
        |
        v
artefacts et diffs immuables
        |
        v
reviewers -> gates -> verdict -> intégration
        |
        +-- vert : mission terminée
        +-- rouge : nouvelle vague / révision
        +-- bloqué : humain, budget ou absence de progrès
```

### Source de vérité

Pour la première tranche :

```text
.oma/missions/<mission-id>/
  workflow.json
  events.jsonl
  artifacts/
  projection.json
```

- `events.jsonl` est append-only et autoritatif ;
- `projection.json` est reconstruisible et non autoritatif ;
- `workflow.json` identifie le workflow intégré et son digest ; il n’exécute
  aucun JavaScript arbitraire dans la première version ;
- les artefacts sont immuables ou adressés par hash ;
- Git porte les modifications de code et leurs identités ;
- aucune base de données externe n’est requise.

Une signature cryptographique, DPAPI, une custody complexe ou un protocole
distribué ne sont pas requis avant la preuve end-to-end.

### Un seul chemin de mutation

Le chemin retenu pour les workflows OMA est :

```text
worker écrit dans son worktree isolé
  -> OMA fige le diff et le manifeste d’artefacts
  -> reviewers lisent exactement ce sujet
  -> le juge exécute les gates
  -> OMA seul intègre dans la branche cible
  -> cleanup après persistance du verdict
```

Le worker ne modifie jamais directement la branche cible.

L’isolation est configurable : un worktree par shard est préférable quand un
worktree par Run serait trop coûteux. Dans un shard, chaque worker possède un
scope sans conflit et ne lance ni commande Git destructive ni build global.
Les compilations et tests coûteux sont regroupés et exécutés par le juge, avec
une concurrence explicitement limitée.

Après revue de chaque diff, OMA applique les diffs acceptés sans conflit dans
un worktree d’intégration, dans l’ordre déterministe des identifiants de
WorkItem. Le juge final s’exécute sur cet ensemble, puis OMA crée exactement un
commit cible. Un conflit crée un Blocker ou un nouveau WorkItem ; il n’est
jamais fusionné automatiquement.

Le hook strict doit donc autoriser les écritures uniquement dans les worktrees
créés et marqués par une mission OMA vivante. Il reste fail-closed ailleurs.
L’ancienne règle « tous les agents sont read-only et passent par MCP » doit être
remplacée dans le même changement que ce chemin de mutation.

Ne pas combiner ce chemin avec un second staging MCP `propose_change`. Le MCP
transactionnel existant peut rester disponible pour d’autres usages, mais il
ne doit pas dupliquer le staging, la revue ou la promotion du workflow.

## 6. État réel du dépôt au départ

### Briques réutilisables

- `src/graph/kernel.ts` : projection et readySet ;
- `src/graph/proposal.ts` et `src/graph/broker.ts` : validation de proposition,
  acyclicité et CAS, après simplification au contact du chemin réel ;
- `src/broker/` : staging et promotion Git, réutilisables seulement après
  suppression du double chemin de mutation et preuve de non-bypass ;
- `src/oracle/` : exécution de gates et revue ;
- `src/runtime/process-runner.ts` et `secret-scrubber.ts` ;
- `src/strict/` : protections, à adapter au worktree OMA autorisé.

### Blocages confirmés

1. L’installateur ne copie ni agents ni skills.
2. Le driver choisit `agy.cmd` alors que la machine fournit `agy.exe`.
3. `modelTier` n’est pas traduit en `--model`.
4. Le scheduler traite un JSON valide comme succès, écrit lui-même la
   complétion broker/oracle et supprime le worktree.
5. Le scheduler ne transporte ni artefacts amont, ni erreurs du juge, ni
   version du rulebook.
6. Le Graph Broker dynamique n’est appelé que par des tests ; aucun résultat
   réel ne produit une révision suivante.
7. Le `MissionJournal` de revue est en mémoire.
8. Le chemin MCP sans mission promeut directement ; le chemin 2PC détruit son
   staging avant revue et ne promeut pas après attestation.
9. `resumeMission` transforme un Run interrompu en échec terminal et ne reprend
   pas le travail initial.
10. La publication graphe puis journal n’est pas atomique en cas de crash.
11. Le test nommé E2E utilise `MockAgyDriver` et assemble manuellement des
    composants déconnectés.
12. Aucun runner de benchmark n’existe.

## 7. Ordre d’implémentation obligatoire

Chaque phase doit satisfaire sa gate avant de commencer la suivante.

### Phase 0 — Juge, fixture et baseline

Construire un dépôt fixture minuscule avec :

- trois unités de travail dont deux parallélisables ;
- tests visibles ;
- tests cachés ;
- deux mutations connues qui doivent être refusées ;
- une gate suffisamment rapide pour être exécutée plusieurs fois.

Les tests cachés et le juge vivent hors des worktrees et répertoires montés aux
agents. Un test visible vert ne doit pas pouvoir promouvoir l’un des mutants.

Avant de fixer le contrat du driver, ajouter un diagnostic en lecture seule
(`oma doctor` ou équivalent de test) qui enregistre :

- chemin et version de `agy.exe` ;
- flags réellement supportés ;
- agents et modèles disponibles ;
- résultat de validation et de découverte du plugin.

La version minimale d’AntiGravity et le contrat de commande sont choisis à
partir de cette observation, pas supposés à partir des noms de champs OMA.

Définir aussi avant l’orchestration :

- `events.jsonl` comme unique journal autoritatif de mission ;
- les identités déterministes `missionId`, `workItemId` et `runId` ;
- un `ProgressVector` versionné propre à la fixture, par exemple nombre de
  tests cachés en échec, erreurs de gate, diagnostics ouverts et WorkItems
  acceptés ;
- l’algorithme d’intégration déterministe décrit en section 5.

Les anciens journaux graphe/ledger deviennent des projections ou des archives.
Aucun nouveau code ne doit maintenir un second flux autoritatif.

Définir dès maintenant le format commun de benchmark et les quatre variantes :

1. AntiGravity nu ;
2. si elle est techniquement reproductible, AntiGravity avec les mêmes
   experts/skills, mais hooks et moteur OMA désactivés ;
3. OMA avec une seule vague statique ;
4. OMA avec Dynamic Workflow et Graph Engineering.

**Gate Phase 0**

- le juge accepte l’original ;
- il rejette chacun des deux mutants ;
- les mutants passent au moins le test visible qui ne doit donc pas suffire à
  leur promotion ;
- les variantes partagent commit, prompt, modèle, effort, permissions, budget,
  timeout et tests cachés ;
- si la variante skills-only n’est pas reproductible, l’écart est documenté et
  remplacé par la baseline la plus proche utilisant la même commande `agy.exe`.

### Phase 1 — Transport AntiGravity et MoE minimal

Ne pas installer huit personas. Commencer avec :

- `planner` ou `explorer` read-only ;
- `worker` dans un worktree ;
- `reviewer` read-only.

Actions :

- packager réellement leurs agents et skills ;
- vérifier leur découverte par `agy plugin validate` et `agy agents` ;
- résoudre `agy.exe` de façon robuste sur Windows ;
- définir un catalogue minimal et un resolver produisant
  `{agentName, modelSlug, effort, sandbox, allowedTools}` ;
- transmettre seulement les flags prouvés par Phase 0 ; toute capacité
  refusée, substituée ou dégradée apparaît dans le reçu et échoue fermée quand
  elle est requise par le WorkItem ;
- adapter le hook strict afin que le worker puisse réellement écrire dans le
  worktree OMA autorisé, sans ouvrir la branche cible ni les autres workspaces ;
- persister dès cette phase les événements minimaux `mission_started`,
  `run_started`, `artifact_created` et `run_finished` dans `events.jsonl` ;
- produire un reçu durable contenant identité, commande normalisée, modèle,
  effort, durée, usage et hashes des sorties nettoyées.

**Gate Phase 1**

- invocation réelle via le plugin installé ;
- aucun `MockAgyDriver` ;
- une écriture réelle réussit dans le worktree OMA et reste refusée hors de ce
  périmètre ;
- un artefact observable est produit et conservé ;
- l’expert, le modèle et l’effort effectivement appliqués sont visibles dans le
  reçu ;
- supprimer la projection puis relire le journal restitue le reçu minimal.

### Phase 2 — Une vague statique réelle

Construire le parcours :

```text
discover
  -> deux WorkItems sans conflit
  -> deux workers en parallèle
  -> deux reviewers indépendants par diff
  -> fixer si nécessaire
  -> judge
  -> intégration unique
```

Le scheduler ne peut pas écrire un verdict broker/oracle. Seuls les composants
ayant cette autorité produisent l’événement terminal correspondant.

Deux reviews sont indépendantes si elles possèdent des `runId` distincts,
reçoivent le même manifeste et le même hash de diff, ne voient ni le raisonnement
du worker ni le verdict de l’autre reviewer et publient chacune leur propre
artefact. La politique de consensus est mécanique et versionnée.

**Gate Phase 2**

- chevauchement temporel réel des deux workers ;
- worktrees ou shards distincts et identités de Run distinctes ;
- deux reviews indépendantes sur chaque diff exact ;
- changements conservés après cleanup ;
- gate rouge : branche cible inchangée ;
- gate verte : application déterministe des diffs, une seule intégration et
  tests cachés verts ;
- un conflit entre diffs produit un Blocker, jamais un auto-merge.

### Phase 3 — Projections Graph Engineering et surfaces

Compléter les événements minimaux de Phase 1 pour projeter les trois graphes.
Séparer `WorkItem` et `AgentRun`. Ajouter les références d’artefacts, reviews,
vérifications, décisions et verdicts.

Le Graph Broker ne maintient pas une seconde vérité : une publication validée
ajoute un événement de mission autoritatif, puis reconstruit la projection. Il
ne remplace pas d’abord un graphe avant d’essayer d’écrire le journal.

Implémenter `oma run`, `oma status --json`, `oma inspect` et la reconstruction
de la projection depuis `events.jsonl`.

**Gate Phase 3**

- supprimer `projection.json`, puis le reconstruire à l’identique ;
- `oma status --json` expose mission, vague, ready/running/blocked, Runs,
  experts, modèles, usage, artefacts, gates et dernier verdict ;
- aucune tâche ne devient réussie sur la seule parole d’un agent.

### Phase 4 — Dynamic Workflow et convergence

Commencer avec un seul workflow intégré `converge-v1`, pas un DSL universel ni
du JavaScript arbitraire chargé depuis la mission :

```text
discover
  -> parallel(implement)
  -> parallel(review, review)
  -> fix
  -> judge
  -> repeat while red and progress
```

Chaque mission enregistre le digest du workflow intégré et la révision du
rulebook. Une modification humaine met le run en pause, publie une nouvelle
révision identifiée, puis reprend explicitement depuis l’état courant.

Les commandes lentes ou globales ne tournent pas dans chaque worker. Le juge
centralise et limite les builds, compilations et suites coûteuses ; leurs
sorties structurées deviennent la file de la vague suivante.

Limites obligatoires :

- `maxRounds` ;
- budget total temps/tokens/agents ;
- fan-out et concurrence maximaux ;
- arrêt après deux vagues sans progrès ;
- arrêt explicite sur blocage humain.

Le `ProgressVector` de Phase 0 est comparé lexicographiquement entre deux
vagues. Chaque nouvelle vague cite les vecteurs avant/après et les hashes de
preuve. Deux vagues sans amélioration produisent `blocked/no_progress` ; la
décision ne dépend pas de l’avis du planner.

Un résultat réel produit la prochaine file. Le graphe initial ne doit donc pas
contenir toutes les tâches finales.

Le `GraphProposal` doit référencer la révision parent, `workflowDigest`,
`rulebookRevision`, numéro de vague, hashes des artefacts déclencheurs et
réservation de budget. Il n’est produit qu’à partir d’un verdict persisté, pas
d’un JSON brut de worker. Les budgets déclarés sont réellement débités, pas
seulement parsés.

**Gate Phase 4**

- une gate rouge injectée crée une nouvelle vague absente du graphe initial ;
- la nouvelle vague possède de nouveaux Runs et des liens vers les preuves qui
  l’ont déclenchée ;
- au moins une erreur systémique met à jour une règle versionnée, ou provoque
  un arrêt explicite si cette modification requiert l’humain ;
- la mission termine sur juge vert, budget ou absence de progrès ;
- aucun retry caché du même Run.

### Phase 5 — Interruption, reprise et suivi

La reprise se fait depuis le journal et les artefacts.

- un Run terminé réutilise son résultat ;
- un Run interrompu devient terminal `interrupted` ;
- si la politique autorise la poursuite, un nouveau Run tente le même WorkItem ;
- un effet Git déjà intégré est réconcilié, jamais dupliqué ;
- aucun worktree n’est nettoyé avant persistance de ses artefacts et verdicts ;
- chaque Run référence `workflowDigest` et `rulebookRevision` ; une reprise
  choisit explicitement les révisions à conserver ou superséder ;
- `run_started` est durable avant le spawn, puis le reçu et les effets Git sont
  réconciliés avant toute nouvelle tentative.

**Gate Phase 5**

- tuer le scheduler après production ou staging ;
- relancer avec `oma resume` ;
- aucun Run réussi n’est réexécuté ;
- le Run interrompu possède une nouvelle tentative explicite ;
- exactement une intégration finale ;
- `oma status` reste lisible pendant et après la reprise.

### Phase 6 — Benchmark causal

Automatiser les quatre variantes définies en Phase 0 sur des runs appariés et
répétés.

Métrique principale : succès aux tests cachés et respect du résultat attendu.

Métriques secondaires :

- faux succès ;
- défauts détectés avant handoff ;
- temps total et chemin critique ;
- tokens et cache ;
- nombre de Runs et de vagues ;
- WorkItems découverts mécaniquement versus prédéclarés ;
- artefacts acceptés au premier passage ;
- erreurs systémiques transformées en règles ;
- couverture réelle par le juge et coût du goulot build/test ;
- interventions humaines ;
- reprise après interruption ;
- conflits et violations d’autorité ;
- coût par mission acceptée ;
- régressions observées après intégration.

**Gate Phase 6**

- runner automatisé et résultats bruts conservés ;
- comparaison à paramètres gelés ;
- aucune revendication de gain sans répétitions suffisantes ;
- les conclusions distinguent qualité, reprise et overhead.

### Phase 7 — Durcissement uniquement après preuve

Après les phases précédentes seulement :

- compléter le catalogue d’experts ;
- renforcer l’atomicité graphe/journal ;
- ajouter signatures, fencing, custody ou isolation plus forte si les tests de
  faute en démontrent le besoin ;
- généraliser le workflow intégré vers des workflows sauvegardables.

## 8. Ce qu’il ne faut pas construire maintenant

- nouveau document d’architecture de plusieurs centaines de lignes ;
- DSL universel de workflow avant la Phase 4 verte ;
- base de données graphe externe ;
- microservices, queue distribuée ou consensus ;
- deuxième chemin de staging/promotion ;
- huit agents superficiels avant les trois agents réels ;
- règle globale rendant tous les workers read-only alors que le workflow leur
  attribue un worktree borné ; seuls les retries locaux non contrôlés restent
  interdits ;
- signatures et custody avant une exécution réelle ;
- benchmark statistique sophistiqué sans données appariées suffisantes ;
- tests qui appellent directement les classes internes et se déclarent E2E ;
- compatibilité avec des schémas ou APIs qui n’ont jamais été livrés.

## 9. Règles de preuve et de communication

Une phase n’est pas terminée parce que :

- TypeScript compile ;
- des tests unitaires passent ;
- un mock renvoie le bon JSON ;
- un fichier d’agent existe ;
- une commande est décrite dans une skill ;
- un agent affirme avoir terminé.

Une phase est terminée quand la surface correspondante a été réellement
observée : plugin découvert, `agy.exe` invoqué, diff conservé, review exécutée,
gate mécanique, reprise après kill ou benchmark apparié.

Pour chaque phase, Gemini doit rapporter :

1. fichiers effectivement modifiés ;
2. commandes exécutées et codes de sortie ;
3. scénario manuel ou live observé ;
4. artefacts ou reçus produits ;
5. limites et éléments non vérifiés ;
6. état Git avant et après, sans nettoyer les modifications préexistantes.

## 10. Définition de fini du produit demandé

OMA satisfait le besoin lorsque, depuis une installation AntiGravity réelle :

1. une demande utilisateur non structurée est lancée par une seule commande ;
2. le graphe initial ne contient pas les WorkItems finaux : `discover` les
   matérialise depuis le dépôt ou les résultats du juge, avec un artefact de
   découverte et une justification des dépendances ;
3. les experts sont routés par capacités, modèle, effort et outils ;
4. plusieurs Runs indépendants travaillent en parallèle ;
5. leurs résultats sont revus et vérifiés avant intégration ;
6. les échecs réels produisent des vagues suivantes bornées ;
7. l’utilisateur suit le run depuis `oma status` ;
8. une interruption reprend sans perte ni duplication ;
9. chaque succès est justifié par une chaîne de preuve ;
10. un benchmark reproductible compare OMA à AntiGravity nu et aux ablations
    utiles.

Tant que ces dix points ne sont pas observés, parler de « solution OMA
opérationnelle », de « full E2E » ou de gain de performance est interdit.
