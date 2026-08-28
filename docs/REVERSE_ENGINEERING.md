# Rétro-ingénierie des plugins « oh-my-* » et d'Antigravity

Date de l'étude : 27 août 2026.

## Périmètre et méthode

L'étude porte sur six instantanés clonés en lecture seule, complétés par la documentation officielle Antigravity et une inspection de la CLI locale.

| Source | Branche | SHA étudié |
|---|---|---|
| `Yeachan-Heo/oh-my-claudecode` | `main` | `08db8be068c2d5e12c061958952715555dc6d1b0` |
| `code-yeongyu/oh-my-openagent` | `dev` | `73a023c024bf77bb3beab05ea81285d7d6f9dc16` |
| `opensoft/oh-my-opencode` | `dev` | `aead4aebd28abf0be5e17f075d66eb76faacf083` |
| `Yeachan-Heo/oh-my-codex` | `main` | `3ad79a8a6fe6e95fdbb8c00e40716fffe4011ce2` |
| `google-antigravity/antigravity-cli` | `main` | `556846a4bb94117222f53846896c7eb0d645307e` |
| `google-antigravity/antigravity-sdk-python` | `main` | `ac516c7709e3baf225c09d8b9d112b07b70066ff` |

L'analyse distingue les faits observés dans le code ou les manifestes, les déclarations de documentation et les décisions proposées pour OMA. Elle ne traite ni le nombre d'étoiles ni les affirmations marketing comme une preuve de performance.

## Conclusions principales

1. La performance de ces projets vient moins du nombre d'agents que de l'alignement avec le harness hôte : hooks, outils natifs, état, modèle de permissions et mode de délégation.
2. Les quatre projets convergent vers le même cycle : comprendre, planifier, décomposer, exécuter, vérifier, corriger et reprendre.
3. Le point de différenciation durable est l'état vérifiable, pas le prompt. Les meilleurs mécanismes possèdent un journal, des transitions autorisées et des gates de preuve.
4. Les architectures les plus récentes séparent le cœur des adaptateurs hôte. Elles évitent cependant l'abstraction universelle tant que les APIs restent instables.
5. Antigravity fournit déjà plugins, agents, sous-agents, hooks, MCP, sandbox et headless JSON. Les réimplémenter serait une dette immédiate.
6. Le manque actuel d'Antigravity n'est pas un moteur de sous-agents. C'est une couche produit cohérente pour représenter et reprendre un travail long sous forme de graphe vérifiable.

## 1. Oh My ClaudeCode

### Architecture observée

OMC est un plugin Claude Code accompagné d'une CLI Node. Son manifeste déclare les skills, commandes et serveurs MCP. Son architecture officielle assemble quatre systèmes : hooks, skills, agents et état.

Le chemin nominal est :

```text
entrée utilisateur -> hooks -> skills -> agents Claude Code -> état local
```

OMC exploite profondément les événements natifs Claude Code : `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Stop` et d'autres événements de session. Les hooks activent les workflows, injectent du contexte, suivent les sous-agents et empêchent une fin prématurée.

Deux mécanismes de parallélisme coexistent :

- le mode `/team`, fondé sur les teams natives de Claude Code ;
- `omc team`, fondé sur des workers CLI dans tmux/psmux.

L'état durable se trouve principalement sous `.omc/`, avec des états de mode, plans, spécifications, artefacts, checkpoints et journaux. Les workflows longs ajoutent une machine d'état au-dessus du modèle.

### Parallèle avec Claude et Claude Code

| Propriété du harness | Adaptation OMC |
|---|---|
| Claude excelle dans les consignes longues et la coordination | Skills et prompts de rôles riches |
| Claude Code expose un système de plugins et hooks | Manifest et hooks natifs très intégrés |
| Claude Code expose Task/subagents et teams | Délégation directe avec modèles Haiku/Sonnet/Opus |
| La famille Claude possède des paliers coût/raisonnement clairs | Routage de rôle par tier `haiku`, `sonnet`, `opus` |
| Les sessions longues compactent le contexte | Checkpoints et restauration autour de `PreCompact` |

OMC est donc performant lorsqu'il reste dans Claude Code. Son runtime tmux devient utile pour des workers externes, mais il duplique une partie des teams natives et ajoute un coût de plateforme.

### À reprendre

- séparer skill, rôle, hook et état ;
- imposer une condition de fin observable ;
- restaurer le contexte depuis des artefacts durables ;
- router les modèles par classe de travail ;
- distinguer clairement la surface interactive de la surface CLI.

### À ne pas copier tel quel

- les mots-clés implicites nombreux et difficiles à raisonner ;
- les catalogues d'agents redondants ;
- tmux comme dépendance centrale sur Windows ;
- les boucles de continuation pilotées uniquement par des hooks et des prompts.

Sources : [architecture OMC](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/08db8be068c2d5e12c061958952715555dc6d1b0/docs/ARCHITECTURE.md), [manifest plugin](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/08db8be068c2d5e12c061958952715555dc6d1b0/.claude-plugin/plugin.json), [hooks](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/08db8be068c2d5e12c061958952715555dc6d1b0/hooks/hooks.json).

## 2. Oh My OpenAgent

### Architecture observée

Le dépôt `oh-my-openagent` publie encore un package racine nommé `oh-my-opencode`, mais il est en cours de transformation en architecture multi-harness.

La séparation cible est explicite :

```text
Core pur -> MCP -> adapters de harness -> packages de plateforme
```

Le cœur contient notamment règles, parsing d'`AGENTS.md`, capacités de modèles, état « boulder », LSP, tmux, teams, mémoire et délégation. Les adaptateurs OpenCode, Codex, Senpi et native encapsulent ces composants dans les APIs de chaque hôte.

Le projet affirme une hiérarchie pragmatique : skill statique d'abord, puis MCP, outil natif et enfin hook. Le hook est considéré comme l'intégration la plus intrusive dans la boucle agent.

Le workflow principal sépare Prometheus pour la planification, Metis et Momus/Oracle pour le challenge, Atlas pour l'orchestration, et Sisyphus Junior avec les spécialistes pour l'exécution. Le plan sous `.omo/plans/` constitue le contrat de handoff. Les catégories sémantiques sont ensuite résolues vers un modèle compatible.

### Parallèle avec les LLM et les coding tools

OMO ne suppose plus qu'un agent logique correspond à un seul fournisseur. Il distingue le nom d'agent, qui porte le comportement, le namespace provider, qui porte l'accès, l'identifiant de modèle, qui porte les capacités, et la catégorie, qui exprime l'intention de la tâche.

Cette indirection est son apport le plus utile. Elle réduit le couplage entre un prompt d'agent et un modèle marketing précis.

L'adaptateur OpenCode reste néanmoins le plus gros et le plus couplé. Le dépôt documente les risques d'injection asynchrone dans la session OpenCode : doublons, boucles et corruption d'état quand plusieurs hooks réagissent au même signal.

### À reprendre

- cœur testable sans dépendance au harness ;
- adaptateurs minces et explicites ;
- catégories de capacité plutôt que modèles codés en dur ;
- plan durable comme contrat d'exécution ;
- priorité aux skills avant les hooks ;
- prompts différenciés selon les familles de modèles lorsque le comportement outil diverge réellement.

### À ne pas copier tel quel

- un monorepo de milliers de fichiers avant validation du besoin ;
- une abstraction complète multi-harness dès le MVP ;
- les migrations et compatibilités héritées propres à OpenCode/Codex ;
- un graphe de dépendances de packages plus complexe que le graphe de travail qu'il doit piloter.

Sources : [ROADMAP et couches](https://github.com/code-yeongyu/oh-my-openagent/blob/73a023c024bf77bb3beab05ea81285d7d6f9dc16/ROADMAP.md#L21-L73), [orchestration](https://github.com/code-yeongyu/oh-my-openagent/blob/73a023c024bf77bb3beab05ea81285d7d6f9dc16/docs/guide/orchestration.md), [adapter Codex](https://github.com/code-yeongyu/oh-my-openagent/blob/73a023c024bf77bb3beab05ea81285d7d6f9dc16/packages/omo-codex/AGENTS.md).

## 3. Oh My OpenCode

### Architecture observée

Le dépôt `opensoft/oh-my-opencode` étudié est une version 3.0.1 plus ancienne et plus compacte que la branche actuelle d'OpenAgent. Il est cependant le meilleur exemple d'un plugin fortement intégré à l'API OpenCode.

Son entrée TypeScript implémente directement `@opencode-ai/plugin`. Elle enregistre une trentaine de hooks, des outils LSP, AST-grep, recherche, session et délégation, un manager de tâches de fond, des agents configurables, des MCP intégrés et compatibles Claude Code, et une configuration JSONC validée par Zod.

La boucle Prometheus -> Atlas -> Junior sépare planification, orchestration et écriture. L'orchestrateur vérifie les diagnostics, builds et tests, tandis que l'exécutant reste borné.

### Parallèle avec OpenCode et les modèles

OpenCode est multi-provider et son plugin SDK expose directement événements, outils, sessions et configuration. Oh My OpenCode profite donc d'une intégration très riche : création de sessions de fond, reprise par `session_id`, outils personnalisés et transformation d'événements.

Le routage par catégories associe par exemple exploration rapide, raisonnement profond, visuel ou rédaction à des modèles différents. Le prompt Sisyphus adapte aussi ses instructions à la famille GPT ou non-GPT lorsque la discipline d'outils diffère réellement.

Cette puissance est également son principal risque : l'orchestrateur dépend des détails de l'API OpenCode et le manager de background agents devient une zone de complexité critique.

### À reprendre

- contrats de délégation explicites ;
- reprise d'un même worker au lieu de recréer son contexte ;
- vérification par le parent, indépendante du self-report ;
- outils limités par rôle ;
- configuration hiérarchique et validée.

### À ne pas copier tel quel

- réimplémenter un manager de sous-agents déjà fourni par Antigravity ;
- multiplier les hooks au point de rendre la boucle opaque ;
- lier le cœur aux noms d'événements d'un harness ;
- associer durablement une catégorie à un modèle précis.

Sources : [base de connaissances du dépôt](https://github.com/opensoft/oh-my-opencode/blob/aead4aebd28abf0be5e17f075d66eb76faacf083/AGENTS.md#L7-L139), [entrée plugin](https://github.com/opensoft/oh-my-opencode/blob/aead4aebd28abf0be5e17f075d66eb76faacf083/src/index.ts), [guide d'orchestration](https://github.com/opensoft/oh-my-opencode/blob/aead4aebd28abf0be5e17f075d66eb76faacf083/docs/guide/understanding-orchestration-system.md).

## 4. Oh My Codex

### Architecture observée

OMX est une couche CLI autour de Codex avec un plugin officiel, un contrat `AGENTS.md`, des skills, des hooks, des agents Codex natifs et un état sous `.omx/`.

Le plugin distribue les skills et métadonnées de hooks/MCP/apps. L'installation configure séparément les agents natifs et l'`AGENTS.md` durable. Le runtime expose des commandes JSON pour l'état, les teams, la mémoire, la trace et le code intelligence.

Le document de taxonomie CLI-first est particulièrement pertinent : la CLI est propriétaire des mutations durables ; MCP sert d'intégration ou de compatibilité et dispose d'un fallback CLI.

L'orchestration combine des sous-agents Codex natifs pour des tranches bornées, une team tmux pour la coordination durable multi-pane, des fichiers d'état par mode et par session, des hooks de cycle de vie, et les efforts de raisonnement Codex.

### Parallèle avec Codex

Codex est très sensible aux contrats `AGENTS.md`, aux skills installés, aux types de sous-agents et à l'effort de raisonnement. OMX place donc son « cerveau » durable dans les instructions de workspace et ses mécanismes de récupération dans une CLI séparée.

Il choisit aussi une frontière saine : les opérations critiques ont une commande `omx ... --json`, plus facile à automatiser et à reproduire qu'un appel MCP opaque.

### À reprendre

- CLI propriétaire de l'état durable ;
- JSON machine-readable pour chaque opération critique ;
- plugin comme projection vérifiée d'une source canonique ;
- séparation sous-agents natifs / runtime team ;
- état session-scoped prioritaire sur le fallback racine ;
- transitions allowlistées plutôt que combinaisons de modes arbitraires.

### À ne pas copier tel quel

- la quantité de modes historiques et de compatibilités ;
- tmux comme condition de workflows essentiels ;
- des états de mode parallèles qui nécessitent une réconciliation complexe ;
- les surfaces que Codex doit ajouter mais qu'Antigravity fournit déjà nativement.

Sources : [manifest plugin OMX](https://github.com/Yeachan-Heo/oh-my-codex/blob/3ad79a8a6fe6e95fdbb8c00e40716fffe4011ce2/plugins/oh-my-codex/.codex-plugin/plugin.json), [modèle d'état](https://github.com/Yeachan-Heo/oh-my-codex/blob/3ad79a8a6fe6e95fdbb8c00e40716fffe4011ce2/docs/STATE_MODEL.md), [taxonomie CLI-first](https://github.com/Yeachan-Heo/oh-my-codex/blob/3ad79a8a6fe6e95fdbb8c00e40716fffe4011ce2/docs/architecture/cli-first-mcp-taxonomy.md), [contrat du bundle](https://github.com/Yeachan-Heo/oh-my-codex/blob/3ad79a8a6fe6e95fdbb8c00e40716fffe4011ce2/docs/plugin-bundle-ssot.md).

## Matrice comparative

| Axe | ClaudeCode | OpenAgent | OpenCode | Codex | Conséquence OMA |
|---|---|---|---|---|---|
| Intégration hôte | Plugin/hooks Claude natifs | Core + adaptateurs | Plugin SDK direct | CLI + plugin + AGENTS | Plugin Antigravity natif, adaptateur CLI mince |
| Parallélisme | Teams natifs + tmux | Selon adaptateur | Sessions background | Sous-agents + tmux | Sous-agents Antigravity natifs d'abord |
| État durable | `.omc` par modes/workflows | `.omo` + boulder | plans/notepads/session | `.omx` par session/mode | Un journal d'événements et une projection graphe |
| Routage modèle | tiers Claude | capacités/fallbacks | catégories/providers | rôle + effort Codex | classe de capacité + effort, résolution tardive |
| Vérification | hooks + verifier | reviewers + gates | parent + LSP/build/test | gates + CLI JSON | nœuds de preuve obligatoires |
| Outils | Claude Code + MCP | core/MCP/adapters | outils plugin riches | CLI-first, MCP compat | natif -> skill -> CLI -> MCP -> SDK |
| Reprise | checkpoints et fichiers | plans/états | session_id/notepad | session state + CLI | replay idempotent du journal |
| Risque majeur | complexité des modes | monorepo/abstraction | couplage OpenCode | dette de compatibilité | garder six rôles et un seul modèle d'état |

## Capacités Antigravity vérifiées

La documentation officielle expose les composants nécessaires :

- plugins contenant `plugin.json`, skills, agents, rules, hooks et MCP ;
- installation CLI locale via `agy plugin install <path>` ;
- agents workspace sous `.agents/agents/<name>/agent.md` ;
- sous-agents asynchrones, supervision et permissions dans `/agents` ;
- hooks `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` et `Stop` ;
- MCP stdio ou distant ;
- mode headless `text`, `json` ou `stream-json` ;
- sélection `--agent`, `--model` et `--effort` ;
- schéma JSON de sortie ;
- SDK Python avec hooks, politiques, structured output, budgets et sous-agents imbriqués à outils isolés.

La CLI installée localement est `agy 1.1.21`. Son aide confirme `--agent`, `--model`, `--effort`, `--input-format stream-json`, `--output-format stream-json`, `--json-schema`, `--sandbox`, ainsi que les sous-commandes `agent`, `mcp` et `plugin`.

La découverte live `agy agents` n'a pas été validée : l'environnement courant n'est pas authentifié et le sandbox refuse l'écriture des logs sous `~/.gemini/antigravity-cli`. Ce point reste donc un gate de QA, pas un acquis.

Sources : [plugins CLI](https://antigravity.google/docs/cli/plugins), [agents CLI](https://antigravity.google/docs/cli/commands/agents/), [headless](https://antigravity.google/docs/cli/headless/), [hooks](https://antigravity.google/docs/hooks/), [MCP](https://antigravity.google/docs/cli/mcp/), [SDK](https://antigravity.google/docs/sdk/overview/), [exemple officiel de sous-agents](https://github.com/google-antigravity/antigravity-sdk-python/blob/ac516c7709e3baf225c09d8b9d112b07b70066ff/examples/getting_started/subagents.py#L15-L46).

## Décisions de conception qui en découlent

### Adopter

- un plugin Antigravity conforme au format officiel ;
- une CLI `oma` responsable de l'état ;
- un DAG d'exécution typé ;
- un journal append-only et des projections reconstructibles ;
- des rôles sémantiques à outils limités ;
- une preuve distincte du rapport de l'agent ;
- des sorties JSON et un driver headless ;
- une source canonique unique pour les assets plugin.

### Différer

- SDK Python en runtime permanent ;
- MCP propre à OMA ;
- SQLite ou base de graphes ;
- orchestration tmux ;
- UI ;
- multi-harness ;
- routage fournisseur avancé.

### Rejeter au MVP

- copier les quatre produits fonctionnalité par fonctionnalité ;
- promettre une « performance équivalente » sans benchmark commun ;
- compter le nombre d'agents comme métrique de qualité ;
- utiliser les hooks comme moteur d'orchestration caché ;
- accepter une fin de tâche sur le seul self-report du LLM.
