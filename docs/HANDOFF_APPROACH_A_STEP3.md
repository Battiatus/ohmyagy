# Passation Gemini — Approche A, Étape 3 (outils graphe + skill conducteur)

**Statut** : `ready-for-agent` · Suite de `docs/SPEC_APPROACH_A_SESSION_NATIVE.md`
**Pré-requis livrés et vérifiés** : Étapes 1 et 2 (Cerveau Neuronal + outils MCP `brain_*`).

---

## Instruction courte à donner à Gemini

> Implémente `docs/HANDOFF_APPROACH_A_STEP3.md` dans l'ordre. Les Étapes 1 et 2 sont
> déjà faites et testées — **ne les réécris pas**. Reproduis exactement le patron
> `src/mcp/brain-tools.ts` (+ son câblage dans `src/mcp/broker-server.ts`) pour les
> outils graphe : ce sont de **fins enrobages MCP du moteur `src/graph/` existant**,
> pas une réimplémentation. Ne déclare une étape terminée qu'après `npm run build`
> (exit 0) **et** `bun test` exécutés localement, sans mock, sans marqueur bâclé.

---

## 1. État actuel (déjà en place, à ne PAS refaire)

### Étape 1 — `src/brain/` (Cerveau Neuronal SQLite)
- `types.ts`, `sqlite-adapter.ts`, `brain-store.ts`, `index.ts`, `__tests__/brain-store.test.ts` (12 tests).
- `BrainStore` = seam de test unique. Schéma SQL conforme à la spec §2.

### Étape 2 — `src/mcp/brain-tools.ts` (outils MCP mémoire)
- Outils `brain_store`, `brain_query`, `brain_summarize`, câblés dans `src/mcp/broker-server.ts`.
- Câblage : accesseur `BrainStore` paresseux (`createBrainAccessor`), champ `brainPath` sur `BrokerConfig` (défaut `.oma/brain.sqlite`, env `OMA_BRAIN_PATH`), `BRAIN_TOOL_DEFINITIONS` étalé dans `tools/list`, dispatch dans `tools/call`, statuts de succès ajoutés à `BRAIN_SUCCESS_STATUSES`.
- Tests : `src/mcp/__tests__/brain-tools.test.ts` (7) pilotent le vrai `handleRequest`.
- Résultat suite complète après Étape 2 : **245 pass / 2 skip / 4 fail**. Les 4 échecs sont **pré-existants** (résolveur `gemini-3.7-pro` vs `agy-default`, timeout de reprise Gate 5.1/5.2, 2 stress CLI headless) — ce sont précisément les composants que l'Approche A remplace. Ne pas les imputer à ce chantier ; les corriger n'est pas l'objet de l'Étape 3.

---

## 2. Contraintes NON négociables (déjà apprises à la dure)

1. **SQLite cross-runtime.** La spec se trompait : `node:sqlite` existe sous Node ≥22 mais **PAS sous Bun 1.3.14** ; `bun:sqlite` existe sous Bun mais pas sous Node. `npm test` tourne sous **Bun**, le build/prod sous **Node**. Tout accès SQLite passe par `src/brain/sqlite-adapter.ts` (`openDatabase`) qui détecte l'hôte. **N'importe jamais `node:sqlite`/`bun:sqlite` en dur.**
2. **Pas de WAL.** `PRAGMA journal_mode=WAL` laisse des `-wal`/`-shm` verrouillés sous Windows. Journal rollback par défaut.
3. **Nettoyage temp Windows.** Après `db.close()`, Windows garde le handle un instant → les teardowns de test retentent `rmSync` sur `EBUSY/EPERM/ENOTEMPTY` (voir `removeTree` dans les tests existants). Réutilise ce helper.
4. **ESM strict.** `type: module`, `moduleResolution: NodeNext`. Imports relatifs **avec extension `.js`** (même pour des sources `.ts`). Requis pour builtins runtime : `createRequire(import.meta.url)`.
5. **Additif uniquement.** Ne modifie pas la logique des suites existantes. Seule exception admise : ajuster une **assertion de comptage** quand tu ajoutes des outils (ex. `broker-server.test.ts` est passé de `9` à `12` à l'Étape 2 ; il passera à `12 + N` outils graphe).
6. **Pas de fausse complétion.** Zéro `TODO`/`FIXME`/`@ts-ignore`/`test.skip`/`.only`/`: any`. Chaque branche implémentée. Tests exécutés **localement**.
7. **Chemins de contrôle protégés.** `broker-server.ts::assertUnprotectedOperations` interdit déjà d'écrire dans `.oma/graph`, `.oma/ledger`, `.oma/control`, `.agents/plugins/oma`. Les outils graphe passent par le moteur, pas par `propose_change` — respecte cette frontière.

---

## 3. Étape 3A — Outils MCP graphe (`src/mcp/graph-tools.ts`)

**Principe : enrober le moteur `src/graph/` existant. Ne rien réinventer.**

### Moteur disponible (symboles exportés à réutiliser)
- `src/graph/store.ts` : `initializeGraphStore(root)`, `loadGraphRuntime(root)`, `appendGraphTransition(...)`, `verifyGraphStore(runtime)`, `graphPaths(root)`.
- `src/graph/broker.ts` : `class GraphBroker`, `validateKahnAcyclicity(...)`, diagnostics de cycle (`GraphValidationDiagnostic`, `KahnResult`).
- `src/graph/proposal.ts` : `parseGraphProposal(input)`, `calculateProposalDigest(...)`, `ProposalValidationError`.
- `src/graph/kernel.ts` : `projectGraph(graph, events)`, `NodeState`, `GraphProjection`, `ProjectedNode`.
- `src/graph/model.ts` : `parseExecutionGraph(value)`, `topologicalNodeIds(graph)`, `GraphNode/GraphEdge/ExecutionGraph`, `parseGraphEvent`.

> **Avant de coder**, lis `src/graph/broker.ts`, `store.ts`, `kernel.ts`, `proposal.ts` en entier et `src/graph/__tests__/` pour reprendre les invariants (Kahn/acyclicité, hash-chaining de graphe, transitions autorisées). Réconcilie le vocabulaire de la spec (`graph_init/propose/apply/ready_nodes/mark_node/inspect`) avec le modèle réel (missions, `GraphBroker`, `run_mission` déjà présent). En cas d'écart de nommage, **suis le moteur existant** et documente le mapping en tête de `graph-tools.ts`.

### Outils à exposer (spec §3)
Mappe chacun sur le moteur ; garde des statuts de succès explicites.

| Outil MCP | Rôle | S'appuie sur |
|---|---|---|
| `graph_init` | initialise un graphe d'exécution pour un objectif, retourne un identifiant | `initializeGraphStore`, `graphPaths` |
| `graph_propose` | soumet une `GraphProposal` atomique (validée, non appliquée) | `parseGraphProposal`, `calculateProposalDigest`, `GraphBroker` (validation Kahn) |
| `graph_apply` | valide + applique une révision au graphe canonique | `GraphBroker`, `appendGraphTransition` |
| `graph_ready_nodes` | liste ordonnée des nœuds prêts (deps satisfaites) | `loadGraphRuntime` + `projectGraph` → filtrer `NodeState === "ready"` |
| `graph_mark_node` | met à jour l'état d'un nœud (`running/succeeded/failed/blocked`) avec preuves | `appendGraphTransition` + `assertTransitionAllowed` (kernel) |
| `graph_inspect` | état complet + métriques de progression | `projectGraph` (+ `verifyGraphStore`) |

### Câblage (copie du patron Brain)
Dans `src/mcp/graph-tools.ts` : exporte `GRAPH_TOOL_NAMES`, `GRAPH_TOOL_DEFINITIONS`, `GRAPH_SUCCESS_STATUSES`, `executeGraphTool(root, toolName, input)`.
Dans `src/mcp/broker-server.ts`, réplique **exactement** ce qui a été fait pour le Brain :
1. importer les 4 symboles ;
2. étaler `...GRAPH_TOOL_DEFINITIONS` dans `tools/list` ;
3. brancher `else if (GRAPH_TOOL_NAMES.has(toolName)) result = executeGraphTool(config.workspaceRoot, toolName, input)` dans `tools/call` ;
4. ajouter `!(… GRAPH_SUCCESS_STATUSES.has(result.status))` au calcul `isError` ;
5. mettre à jour le comptage d'outils dans `broker-server.test.ts` (`12` → `12 + N`) et compléter la liste triée `deepEqual`.

### Tests à créer : `src/mcp/__tests__/graph-tools.test.ts` (spec §Testing §3)
- `graph_init` d'une mission → identifiant retourné, store créé.
- `graph_propose` d'une `GraphProposal` valide → acceptée ; proposition introduisant un cycle → rejetée avec diagnostic Kahn.
- `graph_apply` puis `graph_ready_nodes` → nœuds racines prêts.
- Cycle complet : `graph_mark_node` `succeeded` sur un nœud → progression du DAG, nouveaux nœuds prêts.
- Reprise : re-`loadGraphRuntime` après transitions → aucun travail réussi rejoué (`verifyGraphStore` OK).
Pilote via `handleRequest` (patron `brain-tools.test.ts`) ; teardown `removeTree`.

---

## 4. Étape 3B — Skill conducteur session-native (`oma-start`)

**Fichier** : `.agents/plugins/oma/skills/oma-start/SKILL.md` (16 lignes aujourd'hui : il appelle `run_mission`, qui lance la CLI headless détachée — le « processus fantôme » que l'Approche A supprime).

> ⚠️ **Réconciliation requise avant d'écraser.** `run_mission`/`oma watch` restent utilisés par des tests et d'autres skills. Ne casse pas ces flux : **ajoute** le mode conducteur session-native comme chemin nominal, sans supprimer `run_mission` tant que ses tests n'ont pas été migrés. Vérifie `src/plugin-assets/skills/` et `.agents/skills/` (copies) et `src/packaging/install.js` pour la cohérence d'installation.

Réécris `oma-start` selon spec §4 (boucle du conducteur, dans la session active) :
1. **Inspection de contexte** : lire l'historique de la session + `brain_query` (projet courant).
2. **Alignement interactif** : `ask_question` si ambiguïté.
3. **Init graphe** : `graph_init`.
4. **Plan** : dispatcher le sous-agent `planner` → `graph_propose` adapté à la stack découverte.
5. **Boucle d'exécution native** : tant que `graph_ready_nodes` non vide → dispatcher `sisyphus`/`metis`/`themis` ; chaque fichier via `propose_change` → `attest_review` → gates → `promote_change` ; `graph_mark_node` à chaque transition.
6. **Compaction** : après chaque lot, `brain_summarize` (résumé condensé persistant).

---

## 5. Build / test / vérification (commandes exactes)

```bash
npm run build            # tsc, doit finir exit 0
bun test                 # suite complète (Bun) — ~130 s, timeout 120 s/test
bun test src/mcp/        # itération rapide sur les outils MCP
```

Vérification runtime croisée (le brain/graph doit tourner sous les DEUX) :
```bash
# Sous Node (chemin node:sqlite) — le module compilé doit s'exécuter :
node -e 'import("./dist/src/mcp/graph-tools.js").then(m=>console.log(Object.keys(m)))'
```

Bout-en-bout stdio réel (patron déjà validé pour le Brain) : piper des requêtes JSON-RPC
`initialize` + `tools/call` dans `node dist/src/mcp/broker-server.js` avec
`OMA_WORKSPACE_ROOT` positionné, et vérifier `isError:false`.

---

## 6. Portes d'acceptation (definition of done)

- [ ] `npm run build` : exit 0.
- [ ] `bun test` : aucun **nouveau** fail ; les 4 échecs pré-existants inchangés (ou corrigés séparément et documentés).
- [ ] `graph-tools.test.ts` et (si 3B) tests skill : verts.
- [ ] `broker-server.test.ts` : comptage d'outils et liste triée mis à jour.
- [ ] Aucun marqueur bâclé (`grep -rnE "TODO|FIXME|@ts-ignore|test\.skip|\.only|: any" src/mcp/graph-tools.ts`).
- [ ] Footprint git strictement additif hors ajustements d'assertions de comptage.
- [ ] Bout-en-bout stdio d'un outil graphe : `isError:false`.

---

## 7. Fichiers de référence à ouvrir en premier

1. `docs/SPEC_APPROACH_A_SESSION_NATIVE.md` — la spec (autorité).
2. `src/mcp/brain-tools.ts` + `src/mcp/broker-server.ts` — **le patron exact** à copier.
3. `src/mcp/__tests__/brain-tools.test.ts` — patron de test JSON-RPC.
4. `src/graph/{broker,store,kernel,proposal,model}.ts` + `src/graph/__tests__/` — le moteur à enrober.
5. `src/brain/sqlite-adapter.ts` — l'unique porte SQLite cross-runtime.
