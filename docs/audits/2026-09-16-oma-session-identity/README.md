# Sonde d'identité de session — protocole de mesure

Objectif : **mesurer** ce qu'AntiGravity donne réellement à un serveur MCP et à un hook
de plugin, avant de choisir l'architecture multi-projets. La session précédente a supposé
que `roots/list` suffirait et a livré un correctif annoncé « vérifié » ; les traces de
l'hôte disent l'inverse (§ « Ce qui est déjà mesuré »). On ne recommence pas.

## Ce qui est déjà mesuré, et pourquoi la sonde existe

| Fait | Preuve |
|---|---|
| Un plugin n'est chargé que depuis `~/.gemini/config/plugins/<nom>` | `docs/audits/2026-09-11-oma-host-contract/REPORT.md:110-118` — les plugins déposés dans `<workspace>/.agents/plugins/` n'ont jamais été chargés |
| Un hook tourne avec `cwd` = dossier du plugin, pas le projet | même rapport, §5, payloads réels |
| `roots/list` ne répond rien dans le cas plugin | `~/.oma/bind-attempts.jsonl` : 35 tentatives sur 36 `unresolved`, dont **13 sur 13** depuis `~/.gemini/config/plugins/oma` |
| Un serveur MCP n'a donc aucun moyen de connaître son projet | `src/mcp/broker-server.ts:78` (`workspaceRoot: string`), `:1160-1172` (repli `process.cwd()`) |
| Le hook, lui, reçoit parfois le workspace | 216 enregistrements sur 529 dans `~/.oma/staging` portent un `workspacePaths` non vide, dont `Repos/Symap` (95) et `Agentic/creative ads` (70) |

Conclusion provisoire : l'identité du projet est fixée à l'**installation**, pas à la
**session**. Une seule installation globale ⇒ un seul projet. C'est ce que la sonde doit
confirmer ou infirmer, et surtout **par quel canal** la corriger.

## Les six questions auxquelles la sonde répond

1. Combien de processus serveur MCP l'IDE lance-t-il, et leurs durées de vie se
   chevauchent-elles ? (un serveur partagé, ou un par fenêtre ?)
2. Chaque instance porte-t-elle un signal de projet propre — `cwd`, variable
   d'environnement, ligne de commande du processus parent ?
3. `roots/list` est-il répondu, avec quoi, en combien de temps ?
4. Le payload de hook énonce-t-il le workspace, **et pour quel événement**
   (`PreToolUse` autant que `PostToolUse` ? c'est ce qui décide si le gate strict peut
   devenir propre à un projet)
5. Existe-t-il quoi que ce soit qui relie une instance MCP à une conversation
   (`conversationId`) ?
6. Quel canal peut porter l'identité du projet, et le multiplexage est-il obligatoire ?

## Protocole

```powershell
npm run build
npm run probe:install      # ou: node dist/bin/oma.js probe install
npm run probe:reset        # remet les mesures à zéro : la campagne doit être propre
```

Puis, dans l'ordre :

1. **Quitter complètement AntiGravity** (toutes les fenêtres), puis le relancer.
2. Ouvrir le **projet A**, envoyer une demande qui déclenche au moins un appel d'outil,
   puis une seconde.
3. Ouvrir le **projet B dans une seconde fenêtre**, en laissant A ouvert, et refaire la
   même chose. C'est le point clé : deux projets **simultanément**.
4. Quitter AntiGravity.
5. Lire le résultat :

```powershell
npm run probe:report       # ou: node dist/bin/oma.js probe report
```

Le rapport est aussi écrit en JSON complet dans `~/.oma-probe/report.json`.

Enfin :

```powershell
npm run probe:uninstall            # retire le plugin, garde les mesures
npm run probe:uninstall -- --purge # retire aussi les mesures
```

`probe install` réécrit ses trois fichiers **sur place**, en conservant un `.bak` de
chacun, et ne renomme jamais le dossier : un éditeur ouvert tient ce dossier et un
`rename` échoue en `EBUSY`. Il est donc installable pendant que l'IDE tourne.

## Premier relevé — 16 septembre, 14 h 40 à 14 h 52

Un relevé partiel a déjà eu lieu, involontairement, pendant que la suite de tests
tournait : `npm test` pilote le runtime réel, qui a donc chargé le plugin sonde. Ce n'est
pas un artefact à jeter : c'est le contrat de l'hôte, observé depuis un processus de test.
Le rapport marque ces instances `[test-runner]` comme **provenance**, pas comme exclusion.

| Fait mesuré | Valeur |
|---|---|
| Instances serveur MCP | 22, durée de vie médiane **2,0 s**, concurrence de pointe 2 |
| Modèle de spawn | **`per-query-cold-spawn`** — pas « un serveur partagé », pas « un par fenêtre » |
| Séquence envoyée par l'hôte | `server/discover` → `initialize` → `notifications/initialized` → `tools/list` → fin |
| `cwd` de chaque instance | `~/.gemini/config/plugins/oma-probe`, identique pour toutes |
| Variable d'environnement nommant un projet | **aucune** |
| `roots/list` | 21 requêtes, 15 réponses, **0 portant une racine** |
| Hooks | 14 invocations : `PreToolUse` **7/7** et `PostToolUse` **7/7** avec un `workspacePaths` non vide |
| Projet vu par les hooks | `Repos/AgentsHub`, une seule conversation |

Verdict du rapport : **`hook-channel-only`**, multiplexage requis.

Trois choses que ce relevé change dans le raisonnement :

1. **`roots/list` est un cul-de-sac**, pas une piste à réparer. L'hôte répond — poliment,
   en 95 ms — avec une liste vide. Le correctif du 14 septembre supposait l'inverse ; il
   est réfuté sur l'hôte réel, pas en test.
2. **Un serveur MCP ne vit pas assez longtemps pour porter un projet.** Deux secondes, une
   requête, terminé. Aucune identité de projet ne peut être attachée à la durée de vie du
   processus ; elle doit être résolue **à l'appel** ou liée à la **conversation**.
3. **Le canal hook porte déjà l'information, et sur les deux événements.** `PreToolUse`
   reçoit `workspacePaths` 7 fois sur 7 : le gate strict peut donc être rendu propre à un
   projet sans aucune découverte nouvelle, en résolvant par `conversationId` puis
   `workspacePaths` au lieu de `process.cwd()`.

Ce qui reste à mesurer par la campagne contrôlée, et que ce relevé ne peut pas donner :

- si une instance du **serveur MCP** peut apprendre une identité de conversation
  (le point bloquant restant du canal `hook-channel-only`) ;
- si deux **fenêtres IDE** ouvertes simultanément produisent des instances
  distinguables, ou si elles partagent le même `cwd` et le même environnement ;
- si l'IDE se comporte comme le CLI `agy` observé ici (`server/discover`, spawn froid,
  `roots/list` vide) ou différemment.


## Comment lire le verdict

Le rapport conclut sur un canal, qui détermine directement l'architecture à construire :

| Canal | Ce que ça veut dire | Correctif correspondant |
|---|---|---|
| `host-roots` | L'hôte répond `roots/list` avec une racine | Garder la résolution par handshake, refuser explicitement une liste vide |
| `host-environment` | Rien par `roots/list`, mais l'instance serveur porte un signal (`cwd`, env, parent) | Identifier l'instance, donc un serveur par fenêtre : une table de workspaces suffit |
| `hook-channel-only` | Le hook énonce le projet, le serveur ne reçoit **rien** | Le serveur doit être **multiplexé** et le projet **désigné par la session** (liaison par conversation ou argument explicite) |
| `no-channel` | Rien nulle part | Déclaration explicite obligatoire, sans repli silencieux |

`multiplexingRequired` dit si un seul processus serveur doit servir plusieurs projets.
`per-window-with-cwd` est le seul cas où ce n'est pas nécessaire.

## Ce que la sonde ne fait pas

- **Aucun pin de workspace.** `~/.gemini/config/plugins/oma-probe/mcp_config.json`
  ne contient ni `cwd` ni `env`. C'est la propriété centrale : un pin rendrait la mesure
  nulle, et un test l'interdit (`src/probe/__tests__/probe.test.ts`).
- **Aucun refus.** Les hooks de la sonde répondent toujours `allow` / `{}`. Ils observent,
  ils ne policent pas.
- **Aucune écriture hors de ses deux répertoires** : `~/.gemini/config/plugins/oma-probe/`
  et `~/.oma-probe/`. Le plugin OMA réel et `~/.gemini/config/mcp_config.json` ne sont ni
  lus ni modifiés. Un `oma-probe` existant est **renommé** en `.bak-<horodatage>`, jamais
  supprimé.
- **Aucun secret écrit.** L'environnement complet est journalisé après passage du
  `SecretScrubber` d'OMA (`src/runtime/secret-scrubber.ts`), et cette machine porte des
  clés API vivantes dans les `env` de `~/.gemini/config/mcp_config.json`.

## Coût

Deux processus `node` supplémentaires par appel d'outil (les deux hooks) et un serveur MCP
en plus, pendant une session. C'est temporaire : désinstaller après la mesure.
