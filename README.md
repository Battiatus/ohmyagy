# Oh My Antigravity

Oh My Antigravity est un plugin de coding agent pour Google Antigravity, conçu
en priorité pour la CLI et gouverné exclusivement par un graphe d'exécution
acyclique et événementiel.

Le socle transactionnel `OMA Strict` est implémenté : lecture seule agent,
broker MCP, CAS, staging Git, gates externes, promotion atomique et ledger. Son
ancien contrôle séquentiel a ensuite été remplacé par le Graph Kernel ADR-001.

Documents :

- [Rétro-ingénierie](docs/REVERSE_ENGINEERING.md)
- [Architecture cible](docs/TARGET_ARCHITECTURE.md)
- [Plan d'implémentation](docs/IMPLEMENTATION_PLAN.md)
- [Dynamic Workflow graph-only](docs/DYNAMIC_WORKFLOW.md)
- [Contrôle multi-session et protocole de reprise](docs/MULTI_SESSION_CONTROL.md)

État autoritatif :

```powershell
npm run build
npm test
node dist/bin/oma.js graph status
node dist/bin/oma.js graph ready
```

Le dossier `.oma/control` est une archive du spike transactionnel antérieur. Il
n'est plus exposé par la CLI et ne sélectionne plus le travail. La seule source
de vérité d'exécution est `.oma/graph/execution-graph.json`, projetée depuis
`.oma/graph/events.jsonl`.

OMA n'implémente aucune boucle autonome de continuation, Ralph loop ou
`verify/fix until done`. Chaque nœud est dispatché une seule fois par révision.
Un échec active une arête `failure` déclarée vers un autre nœud ou une décision
humaine. Les cycles, self-loops et retries implicites sont refusés au parsing.

Installation workspace Antigravity (IDE et validation locale) :

```powershell
node dist/bin/oma.js plugin install-workspace
agy plugin validate .agents/plugins/oma
```

La CLI Antigravity charge les plugins installés dans son profil global. Cette
étape est persistante et doit donc être exécutée explicitement par l'utilisateur :

```powershell
agy plugin install .agents/plugins/oma
agy plugin list
```

Le plugin expose un unique outil MCP d'écriture, `propose_change`. L'agent ne
peut pas modifier directement les fichiers, lancer un shell, altérer les gates
ou écrire dans `.oma/control` et `.oma/graph`; le broker valide la version parent, applique la
transaction dans un worktree détaché, exécute les gates fixes, puis promeut en
un seul commit fast-forward. Le dépôt cible doit donc déjà être un dépôt Git
propre.

État de l'archive du spike : toutes ses checks, y compris `LIVE-001`, sont
acceptées. Cette première preuve live est épinglée dans
`test-fixtures/live/agy-cli-audit.json` et revérifiable avec `npm run test:live`.

La bascule Graph Kernel possède une seconde preuve live dans
`test-fixtures/live/agy-graph-audit.json`. Elle démontre sur Antigravity CLI
authentifiée que le DAG reste lisible, qu'un dispatch par shell est refusé et
que le broker rejette une mutation de `.oma/graph` avant même la découverte Git.
