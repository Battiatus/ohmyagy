# État des lieux OMA — 30 août 2026

Document de recadrage. Écrit après une session qui s'est éloignée du besoin.
Il sert de base de décision.

---

## 1. Le besoin, décortiqué

OMA doit être un plugin qui s'interface avec Antigravity, dans la lignée
d'oh-my-claudecode, oh-my-codex et oh-my-opencode. Six capacités le composent.

| # | Capacité | Ce que ça veut dire concrètement |
|---|---|---|
| **A** | **Experts spécialisés** | Un catalogue de rôles — orchestrateur, planner, explorer, executor, reviewer, verifier — chacun avec ses outils autorisés, sa classe de modèle et son niveau d'effort. Logique Mixture of Experts : le bon expert sur la bonne tâche, pas un agent généraliste qui fait tout. |
| **B** | **Protocoles longs et complexes** | Une mission confiée une fois s'exécute sur plusieurs étapes, plusieurs experts, en parallèle quand les dépendances le permettent. Interruptible et reprenable. |
| **C** | **Suivi** | À tout instant : quels nœuds sont faits, en cours, prêts, bloqués. Lisible depuis le terminal, pas depuis la mémoire d'un LLM. |
| **D** | **Assurance de réalisation** | Un expert ne peut pas déclarer sa propre réussite. Une tâche est finie quand une preuve observable existe — test, diff, gate déterministe. |
| **E** | **Benchmark** | Mesurer les runs OMA contre Antigravity utilisé seul, sur les mêmes tâches, modèles et budgets gelés. C'est la seule chose qui dira si le plugin apporte quelque chose. |
| **F** | **Base technique imposée** | **Graph Engineering** — le workflow est un DAG typé et versionné, pas une boucle. **Dynamic Workflow** — le DAG peut croître pendant la mission par révisions successives validées hors du LLM. |

Interdit explicite ([REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md),
conclusion 5) : réimplémenter ce qu'Antigravity fournit déjà — sous-agents,
hooks, MCP, sandbox, sortie headless JSON. C'est une dette immédiate.

---

## 2. Ce que les plans disaient

Trois documents antérieurs à cette session portent le plan réel. Aucun n'est
périmé.

**[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** — neuf work packages avec
un ordre de dépendance :

```
WP-0 Contrats ─┬─> WP-1 Bundle plugin ─┬─> WP-3 Driver agy ─> WP-4 Scheduler
               └─> WP-2 CLI + graphe ──┘        ─> WP-5 Vérification
                                                ─> WP-6 Reprise et sécurité
                                                ─> WP-7 Surfaces / WP-8 Benchmark
```

Et un « plus petit test utile », à construire **avant** le produit complet :

```
installer plugin -> mission à 3 nœuds -> déléguer 2 nœuds indépendants
-> interrompre -> reprendre -> vérifier -> exporter graphe et preuves
```

**[ADR-001](architecture/ADR-001-graph-kernel.md)** — le control plane est un
DAG versionné. Cycles refusés au parsing, un nœud dispatché au plus une fois par
révision, `readySet` complet sans choix du LLM, arêtes
`success`/`failure`/`always`, autorités de complétion séparées. Aucun retry
implicite, aucun loop engineering.

**[DYNAMIC_WORKFLOW.md](DYNAMIC_WORKFLOW.md)** — le DAG cesse d'être prédéfini.
Le LLM propose un `GraphProposal`, un `Graph Broker` séparé le valide, une
révision N+1 immuable et signée est publiée par CAS. Une information nouvelle ne
réactive jamais un ancien nœud : elle crée de nouveaux nœuds. Ce document se
déclare lui-même « point de reprise obligatoire de la prochaine session ».

---

## 3. Ce que j'ai fait dans cette session

J'ai travaillé exclusivement sur **ADR-002**, un quatrième document décrivant un
« plan d'orchestration », que la session précédente m'avait légué comme
périmètre.

1. Réécrit ADR-002 de 518 à 1364 lignes, en trois révisions (4, 4.1, 4.2).
2. Lancé trois passes de challenge adversarial Codex `gpt-5.6-sol`. Verdict à
   chaque tour : REJECT. Une des impossibilités relevées était de ma main :
   j'avais spécifié une revue devant précéder un commit tout en dérivant son
   sujet de ce même commit.
3. Construit deux morceaux de code issus de cet ADR :
   - **Revue sur transaction stagée** — le broker prépare une modification,
     calcule l'empreinte de son diff, et la promotion est refusée si le diff
     committé diffère du diff attesté par un relecteur approuvé.
   - **Mode strict lié à la mission** — un hook `PreToolUse` installé dans
     Antigravity refusait tout outil d'écriture **en permanence**, mission ou
     non, ce qui bloquait l'usage normal d'Antigravity. Il est désormais
     transparent hors mission et fail-closed pendant.
4. Vérifié : `npm run build` exit 0, `npm test` 84 tests, 83 pass, 0 fail,
   1 skip préexistant.

**Rapporté au besoin** : ce travail touche la capacité **D** seulement, et
seulement sur le papier — le mécanisme de revue est branché sur une classe que
le serveur MCP réellement installé n'appelle pas. Les capacités **A, B, C, E, F**
n'ont pas bougé.

---

## 4. Ce qui existe réellement dans le code

Environ 5 900 lignes de TypeScript hors tests.

| Module | LOC | Ce que c'est | Réutilisable ? |
|---|---|---|---|
| `src/graph/` | 1108 | **Graph Kernel.** Nœuds `agent`/`broker`/`gate`/`join`/`human`, autorités `broker`/`oracle`/`scheduler`/`human`, activation `all`/`any`, arêtes conditionnelles, projection déterministe, garde de transition. CLI : `init`, `status`, `ready`, `dispatch`, `complete`. | **Oui — c'est le socle F.** |
| `src/ledger/` | 1127 | Journal signé, autorité de signature, journal de mission. | Oui, C et D. |
| `src/broker/` | 1042 | Staging, promotion, revue sur transaction stagée. Chemin de mutation exclusif. | Oui, D. |
| `src/control/` | 999 | Spike archivé : contrat de mission, checks d'acceptation, preuves, invalidation par hash d'entrées. | Partiellement — la péremption des preuves est à récupérer. |
| `src/strict/` | 407 | Hook Antigravity : refuse les outils de mutation directe hors du broker. Désormais lié à une mission vivante. | Oui, D. |
| `src/oracle/` | 339 | Gates, attestation de revue, couverture. | Oui, D. |
| `src/mcp/` | 292 | Serveur MCP `propose_change` — seul point de contact réel avec Antigravity aujourd'hui. | Oui, mais défectueux, §6. |
| `src/resume/` | 213 | Reprise. | Oui, B. |
| `src/packaging/` | 131 | Installation du bundle. | Oui. |
| `src/runtime/` | 121 | Injection de l'artefact diff dans le manifeste du relecteur. | Oui, D. |
| `src/policy/` | 66 | Registre de politique par classe de mission. | Oui, D. |
| `src/orchestration/` | 40 | Contrats typés de la tranche construite aujourd'hui. | Marginal. |
| `src/plugin-assets/` | — | `plugin.json`, `hooks.json`, `skills/` **vide**. | Incomplet. |

---

## 5. Ce qui n'existe pas

| Manque | Capacité bloquée | Gravité |
|---|---|---|
| **Aucune invocation de `agy`.** Zéro occurrence dans tout `src/`. | A, B, C, E | **Bloquant absolu.** Rien ne s'exécute. |
| **Aucun fichier d'expert.** Pas de dossier `agents/` dans le bundle. Les six rôles n'existent nulle part. | A | Bloquant. |
| **Aucune skill dans le bundle.** `src/plugin-assets/skills/` est vide. | A, B | Bloquant. |
| **`GraphProposal` et `Graph Broker` non écrits.** | F | Bloquant — le graphe ne peut pas croître, donc reste entièrement prédéfini. |
| **Aucun scheduler** reliant `readySet` à des invocations réelles. | B, C | Bloquant. |
| **Aucun benchmark**, aucun dépôt fixture, aucune mission de référence. | E | Bloquant, mais en aval. |

Le driver `agy` est le **WP-3**, chemin critique du plan d'implémentation. Tout
ce que j'ai construit cette session relève des **WP-5 et WP-6**, deux à trois
crans en aval.

---

## 6. Problématiques ouvertes

**Le chemin MCP installé contourne la revue.**
[`src/mcp/broker-server.ts:125`](../src/mcp/broker-server.ts) appelle
`promoteApprovedTransaction()` sur approbation de gate seule.
`StagedReviewBroker`, qui porte tout l'enforcement construit aujourd'hui, n'a
pour appelants que ses propres tests. Le serveur qu'Antigravity charge
réellement n'est donc pas protégé. Détecté par Codex après que j'aie annoncé la
chose fonctionnelle sur la foi de 84 tests verts.

**Trois ordres de construction concurrents, non réconciliés.**
`DYNAMIC_WORKFLOW.md` en porte un en 9 étapes, `IMPLEMENTATION_PLAN.md` un en
9 work packages, `ADR-002 §19.7` un troisième en 8 rangs. Personne n'a tranché
lequel gouverne.

**ADR-002 n'est pas en vigueur, et le dit lui-même.** Sa §17 maintient ADR-001
comme autorité jusqu'à une condition de bascule exigeant 44 critères plus un
benchmark favorable. La session a durci un plan non adoptable.

**Le lot `src/graph/**` n'est pas commité** et Codex l'avait classé `high`,
déconseillant de le livrer en l'état. C'est pourtant le socle.

**`OMA_GATES_PATH` subsiste** dans le `mcp_config.json` installé, alors
qu'ADR-002 §13.3 le supprime et que son interdit #18 le proscrit.

**Fail-closed du mode strict non prouvé de bout en bout.** Le fail-open hors
mission est prouvé sur le binaire installé ; l'inverse ne l'est pas, une
tentative ayant échoué sur un pid Git Bash invalide comme pid Windows.

**Zéro commit.** Tout est dans l'arbre de travail.

**Coût de la session** : environ 190 dollars, sept heures, pour zéro avancée sur
cinq des six capacités.

---

## 7. Ce qui reste à faire

Dans l'ordre de dépendance réel.

**1. Les experts** — six fichiers `agent.md` dans le bundle : rôle, outils
autorisés, classe de modèle, effort. Minimal. C'est la capacité A, et elle n'a
aucune dépendance.

**2. Le driver `agy`** — `agy -p <contrat> --agent <nom> --output-format json`,
une invocation bornée par nœud, jamais `--continue`, timeout, sortie structurée
parsée. C'est WP-3, le chemin critique. Sans lui, rien du reste n'est
observable.

**3. Le scheduler** — relier le `readySet` du graphe existant à des invocations
réelles du driver. Un nœud, une invocation.

**4. La tranche verticale du plan** — mission à 3 nœuds sur dépôt fixture, deux
nœuds parallèles, interruption, reprise, vérification, export du graphe et des
preuves. C'est le test qui dit si le pari tient.

**5. Le Graph Broker** — `GraphProposal`, validation hors LLM, publication par
CAS de la révision N+1. C'est le Dynamic Workflow ; il n'a de sens qu'une fois
qu'une mission statique tourne.

**6. Le benchmark** — OMA contre Antigravity nu, mêmes tâches, modèles et
budgets gelés.

À ne **pas** reprendre avant que la tranche tourne : les 44 critères d'ADR-002,
le mutateur de calibration, le fencing par époque, la custody d'épingle, et le
correctif de `broker-server.ts:125`.

---

## 8. Documents produits ou modifiés dans cette session

| Document | Nature |
|---|---|
| [architecture/ADR-002-orchestration-plane.md](architecture/ADR-002-orchestration-plane.md) | Réécrit, 518 → 1364 lignes, révisions 4 / 4.1 / 4.2. Non ratifié. |
| `architecture/.ADR-002.rev3.bak` | Sauvegarde de la révision 3. |
| [HANDOFF.md](HANDOFF.md) | Sections d'état réécrites. Reflète le périmètre ADR-002, donc partiellement hors sujet. |
| `%TEMP%\oma-handoff-2026-08-30.md` | Passation orientée ADR-002. Même biais. |
| Ce document | Recadrage sur le besoin réel. |

Documents **antérieurs**, non écrits dans cette session, qui portent le plan réel
et restent la référence : [ADR-001](architecture/ADR-001-graph-kernel.md),
[DYNAMIC_WORKFLOW.md](DYNAMIC_WORKFLOW.md),
[TARGET_ARCHITECTURE.md](TARGET_ARCHITECTURE.md),
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md),
[MULTI_SESSION_CONTROL.md](MULTI_SESSION_CONTROL.md),
[REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md).
