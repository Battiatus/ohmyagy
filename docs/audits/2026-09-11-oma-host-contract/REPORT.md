# Contrat hôte AntiGravity pour les hooks OMA — capture et défauts prouvés

Date : 11 septembre 2026. Hôte mesuré : **AGY CLI 1.2.1** (Windows x64).
Code OMA audité : branche `dev`, à partir de `4c5b2ba`.

Ce document ne remplace pas `../2026-09-10-oma/REPORT.md` : il le complète avec ce
qui n'était alors que supposé. Chaque affirmation est reliée à une observation
reproductible ; aucune n'est déduite de la documentation ou d'un commentaire.

> **Caveat de version.** AGY s'est mis à jour de 1.2.0 à 1.2.1 *pendant* la
> campagne de mesure (binaire réécrit le 11/09 à 12:33:39). Le contrat ci-dessous
> est épinglé à 1.2.1. À remesurer après toute mise à jour de l'hôte.

---

## 1. Méthode

Aucune déduction. Trois instruments :

1. **Extraction de chaînes du binaire** (`agy.exe`, Go) pour identifier le type
   de décodage réel : `map[string]jsonhook.JSONHookSpec`, `jsonhook.ToolHookGroup`,
   `jsonhook.HookHandler.IsCommand|Timeout|PromptText|Model`.
2. **Sondes vivantes** : plugins `hooks.json` minimaux déposés dans le store
   global, puis exécution de `agy -p` avec `--log-file` et lecture des rejets,
   plus des fichiers-marqueurs écrits par le hook lui-même.
3. **Capture du payload** : hook sonde `dump.cjs` qui journalise
   `process.cwd()`, `process.argv` et le JSON reçu sur stdin.

Artefacts bruts conservés dans ce répertoire :
`hook-payloads.jsonl` (payloads réels), `dump.cjs` (sonde), `arm-liveness.mjs`
(armement du marqueur de mission), `extract-check.mjs` (confrontation de
l'extracteur livré aux payloads réels).

Commandes de reproduction en fin de document.

---

## 2. Contrat de `hooks.json` (fait n°1)

Le fichier est décodé en **`map[string]jsonhook.JSONHookSpec`** :

- **chaque clé de premier niveau est un NOM de hook** ;
- chaque valeur doit être un objet exploitable, soit comme *command hook* (elle
  porte alors `command`), soit comme *groupe d'événements* indexé par un nom
  d'événement **supporté** ;
- les clés inconnues sont ignorées ; si un spec ne déclare alors aucun groupe
  reconnu, il est validé comme command hook et échoue avec
  `invalid hook "<nom>": command hook must specify 'command'` ;
- **un seul hook invalide invalide TOUT le fichier** : le runtime journalise
  `Failed to parse hooks for plugin <nom>` et n'enregistre **aucun** hook ;
- un **BOM UTF-8** fait échouer le décodeur avant toute lecture
  (`invalid character '\ufeff' looking for beginning of value`).

C'est ce « tout ou rien » qui a fait tomber la porte d'écriture stricte d'OMA en
même temps que son hook mémoire.

### Événements, avec preuve

| Événement | Parse | Se déclenche | Preuve |
|---|---|---|---|
| `PreToolUse` | oui | oui | un `{"decision":"deny",...}` est décodé et **fait autorité** (§4) |
| `PostToolUse` | oui | oui | le modèle a reçu `jsonhook__oma-probe_PostToolUse_0_0 failed` puis `jsonhook__probe-posttooluse_PostToolUse_0_0` sur deux campagnes distinctes |
| `SessionEnd` | oui | **non observé** | parse propre, mais aucun marqueur écrit sous `agy -p` |
| `SessionStart` | **non** | — | `invalid hook "probe-sessionstart": command hook must specify 'command'` |
| `Stop` | **non** | — | `invalid hook "probe-stop": ...` (mesure dans un fichier où `SessionEnd` passait) |
| `UserPromptSubmit` | non mesuré | — | ne pas émettre sans capture |

Conséquence collatérale importante : `SessionStart` étant rejeté, les plugins
`superpowers`, `agy-connector`, `claude-connector`, `codex-connector` et
`grok-connector` **ne chargent jamais leurs hooks** non plus. Le défaut n'est pas
propre à OMA, et cela explique aussi pourquoi les variantes Claude/Gemini
`{"hooks": {...}}` sont rejetées : la clé `hooks` devient un nom de hook.

---

## 3. Décodage du résultat de hook (fait n°2)

La sortie stdout d'un hook est décodée **en protojson, contre le message de
résultat de l'événement qui a tiré**. Un champ inconnu est une **erreur dure**,
remontée à l'agent :

```
Encountered error in tool execution: failed to unmarshal result from hook
jsonhook__probe-post_PostToolUse_0_0 via protojson: {"decision":"allow",...}:
proto: (line 1:2): unknown field "decision"
```

Observations :

- sur `PreToolUse`, `{"decision":"allow"|"deny","reason":"..."}` est **valide et
  appliqué** ;
- sur `PostToolUse`, le message de résultat **n'a pas** de champ `decision` :
  l'émettre **casse le résultat de l'outil** ;
- un hook qui sort en code ≠ 0 casse également l'outil
  (`JSON hook "..." failed: command failed: exit status 1`) ;
- **il n'existe pas de format unique** : chaque événement a son propre message de
  résultat. La seule sortie sûre pour un hook best-effort est `{}`, qui décode
  dans n'importe quel message.

`brain/summarizer-hook.ts` émettait `{"continue": true}` — un idiome Claude Code,
donc invalide ici. C'est le risque introduit en réparant `hooks.json` : tant que
le fichier était rejeté, le hook ne tournait jamais ; une fois le fichier
accepté, il se mettait à tourner avec une sortie non décodable. Corrigé (commit
`205eb93`).

---

## 4. Portée de découverte : le store global uniquement (fait n°3)

AGY charge les plugins depuis **`~/.gemini/config/plugins/<nom>`**. Les plugins
déposés dans `<workspace>/.agents/plugins/<nom>` **n'ont jamais été chargés** :
six plugins-sondes, aucune mention dans les journaux, aucun marqueur.

Conséquence directe pour OMA : `oma install` en mode workspace écrit des
`hooks.json` et `mcp_config.json` **inertes**. Seule l'installation globale
(`oma install --global`) atteint un emplacement que le runtime lit. Les
commandes et skills, eux, restent visibles dans le workspace — la nuance est
réelle et n'est pas tranchée ici.

---

## 5. Environnement d'exécution d'un hook (fait n°4)

Payloads réels capturés (`hook-payloads.jsonl`) :

```json
{"at":"2026-09-11T13:02:47.308Z","event":"PreToolUse",
 "cwd":"C:\\Users\\User\\.gemini\\config\\plugins\\oma-probe",
 "payloadKeys":["artifactDirectoryPath","conversationId","modelName","stepIdx","toolCall","transcriptPath","workspacePaths"],
 "payload":{"artifactDirectoryPath":"C:/Users/User/.gemini/antigravity-cli/brain/223a15bf-...",
   "conversationId":"223a15bf-3688-4962-b150-b63f8e60ac82",
   "modelName":"gemini-3.8-flash-high","stepIdx":2,
   "toolCall":{"args":{"AbsolutePath":"C:\\...\\SKILL.md",...},"name":"view_file"},
   "transcriptPath":"C:/Users/User/.gemini/antigravity-cli/brain/223a15bf-.../.system_generated/logs/transcript_full.jsonl",
   "workspacePaths":[]}}
```

Trois faits décisifs :

1. **`cwd` = le répertoire du plugin**, pas le workspace.
2. **`workspacePaths` est un tableau vide.**
3. Sur `run_command`, `toolCall.args.Cwd` vaut `C:\Users\User\.gemini\antigravity-cli` —
   le répertoire d'AGY, pas celui du projet.

`PostToolUse` ajoute `error` (chaîne vide en cas de succès).

### Le transcript est réel et structuré

`transcript_full.jsonl` existe, et contient une ligne par étape avec
`type` (`USER_INPUT`, `PLANNER_RESPONSE`, ...), `step_index`, `source`, `status`,
`created_at`, `content`, `thinking`, `tool_calls`. C'est une source condensable
idéale — bien meilleure qu'un texte brut.

**Mais la racine du projet n'y figure pas** (vérifié : le chemin du workspace est
absent). Le hook ne peut donc pas déterminer à lui seul le projet auquel il
appartient. Toute conception qui l'exige est irréaliste en l'état.

---

## 6. La porte d'écriture stricte : elle s'exécute (fait n°5)

En armant le marqueur de mission au cwd réel du hook, la politique s'applique
réellement. Le modèle a reçu, textuellement :

```
tool call denied by pre-tool hook: Command execution outside an authorized OMA worktree is disabled in strict mode.
tool call denied by pre-tool hook: Filesystem read view_file targets a path outside mounted workspaces.
```

Ces deux chaînes sont **les raisons exactes de `src/strict/policy.ts`**
(lignes 140 et 165). Donc `strict/hook.ts` est invoqué, `{"decision":"deny"}` est
décodé, et l'outil est bloqué.

### Mais elle est inerte en production, pour trois raisons cumulées

| # | Défaut | Preuve |
|---|---|---|
| G1 | `strict/hook.ts` décide de la liveness via `isMissionLiveFor([process.cwd()])`, or `process.cwd()` est le **répertoire du plugin** | §5 fait 1 |
| G2 | aucun code de production n'appelle `startMissionLiveness` : seuls `src/strict/__tests__/policy.test.ts` le font. Le marqueur `.oma/v2/missions/<id>/live.json` n'existe donc jamais | `grep` des appelants |
| G3 | `evaluateWorkspaceRead` exige `workspacePaths` non vide ; le payload fournit `[]` → `insideWorkspace === false` → **toute lecture refusée** | §5 fait 2 + `policy.ts:149-165` |

G1 rend le gate structurellement inarmable (les ancêtres du répertoire de plugin
ne contiendront jamais le marqueur d'un projet). G2 le rend inerte même si G1
était corrigé.

**G3 est le point le plus grave : armer ce gate aujourd'hui rendrait la session
inutilisable.** Chaque `view_file`, `list_dir`, `grep_search`, `find_by_name`
serait refusé (« outside mounted workspaces ») et chaque `run_command` aussi
(son `Cwd` n'est jamais un worktree OMA). La politique suppose l'architecture
détachée + worktrees, retirée en Phase 8 ; elle doit être **redérivée du payload
réel** avant d'être activable.

---

## 7. Le hook mémoire : non fonctionnel sur trois axes (fait n°6)

`extract-check.mjs` exécute l'extracteur **livré** contre les payloads réels :

```json
{"event":"PreToolUse","extractedLength":0,"hookWouldCapture":false,
 "summarizerLooksForSessionId":false,"agyActuallyProvidesConversationId":true}
```

| # | Défaut | Effet |
|---|---|---|
| M1 | `extractInteractionText(payload)` renvoie **0 caractère** sur les 4 payloads réels : il attend un tableau `messages` façon Claude, AGY envoie `toolCall`/`transcriptPath` | `passthrough()` → **aucune capture** |
| M2 | le code lit `session_id`/`sessionId` ; AGY fournit **`conversationId`** | toutes les sessions hôte se replient sur la session Brain unique `"default"` |
| M3 | l'événement `Stop` était rejeté, et `SessionEnd` ne se déclenche pas sous `agy -p` | le hook n'était de toute façon jamais appelé |

Conclusion : l'exigence « chaque échange reformulé par Flash, toujours dessus »
est **impossible** avec l'implémentation actuelle, et ce indépendamment du
problème de packaging déjà corrigé.

---

## 8. Bloqueur tiers neutralisé (fait n°7)

Le plugin `googlecloudtools.datacloud_telemetry` déclare un `PreToolUse` dont la
commande est mal quotée sous Windows. Il sortait 1 à **chaque** appel d'outil et
bloquait toute exécution :

```
JSON hook "jsonhook__googlecloudtools.datacloud_telemetry_PreToolUse_0_0" failed: exit status 1
Error: Cannot find module 'C:\...\plugins\...\"C:\...\telemetry_hook_bundle.js"'
```

En clair, aucune session AGY ne pouvait exécuter d'outil. C'est le suspect n°1 du
« sans résultat » signalé. Son `hooks.json` a été mis à `"enabled": false`
(sauvegarde `hooks.json.f3bak`). Mesure après neutralisation : exécution d'outil
normale, plus aucune erreur de hook.

---

## 9. Modifications d'environnement effectuées

Toutes réversibles, toutes hors du dépôt produit :

| Objet | Action | Réversion |
|---|---|---|
| `~/.gemini/config/plugins/googlecloudtools.datacloud_telemetry/hooks.json` | `enabled: false` | restaurer `hooks.json.f3bak` |
| `~/.bun/bin/oma.exe`, `oma.bunx` | renommés `.broken-20260911` (cible inexistante) | renommer en arrière |
| `~/.gemini/config/plugins/oma-probe/` | supprimé après mesure | recréer si besoin |
| `~/.gemini/config/plugins/oma/.oma/` | marqueur d'armement supprimé | — |

État final vérifié : `oma doctor --attest` → `exit 0`,
`install=True loaded=True tested=True`, `hooks valid=True`,
`runtimeHookRejections=0`, broker `23` outils, `0` manquant.

---

## 10. Ce qui reste non prouvé

- **`SessionEnd` ne se déclenche pas** sous `agy -p`. Son déclenchement en
  session interactive, et la forme de son message de résultat, restent inconnus.
- **`UserPromptSubmit`** n'a pas été sondé.
- **G3 du plan initial** — `/oma-start` produisant un identifiant visible — est
  prouvé pour sa moitié mécanique : `graph_init` puis `oma status` affiche bien
  `mission-<id>` sans qu'aucun nœud ne soit exécuté. La moitié « le modèle AGY
  appelle réellement les outils OMA » exige une session interactive avec
  l'entretien répondu, donc un humain.
- La nuance **commandes/skills visibles depuis le workspace** vs **plugins/hooks
  lus uniquement du store global** n'a pas été tranchée.
- Le contenu métier des bases Symap reste hors périmètre.

---

## 11. Reproduction

```powershell
# 1. Sonder quels événements le parseur accepte (dans le store GLOBAL)
#    hooks.json = { "<nom>": { "enabled": true, "<Événement>": [ { "matcher":"*",
#                   "hooks":[ { "type":"command", "command":"node ... ", "timeout":10 } ] } ] } }
#    Écrire SANS BOM, puis :
agy -p "Reply with exactly: OK" --log-file .\probe.log --print-timeout 120s
Select-String -Path .\probe.log -Pattern 'Failed to parse hooks'

# 2. Capturer le payload réel
#    enregistrer dump.cjs sur PreToolUse ET PostToolUse, puis une commande :
agy -p "Run the shell command 'echo payload-probe' and reply DONE." --log-file .\dump.log
Get-Content .\hook-payloads.jsonl

# 3. Prouver que le gate s'exécute (il faut l'armer : rien en production ne le fait)
node .\arm-liveness.mjs "C:\Users\User\.gemini\config\plugins\oma" probe-gate
agy -p "Run the shell command 'echo gate-armed-test'" --print-timeout 180s
# attendu : "tool call denied by pre-tool hook: Command execution outside an authorized OMA worktree..."

# 4. Confronter l'extracteur livré aux payloads réels
node .\extract-check.mjs .\hook-payloads.jsonl
```

---

## 12. Ce que ce document implique pour la refonte

1. Le hook mémoire doit passer sur **`PostToolUse`** (accepté, se déclenche,
   porte le payload) et sortir **`{}`**.
2. Il **ne peut pas** résoudre le projet : le payload ne le donne pas. La capture
   doit donc être **project-agnostique et durable**, et l'attribution au projet
   faite par le côté qui connaît le workspace.
3. La source de condensation est **`transcript_full.jsonl`**, avec un curseur
   persistant — jamais un parseur de texte brut.
4. La clé de session est **`conversationId`**.
5. La porte d'écriture stricte ne doit **pas** être armée tant que
   `workspacePaths` est vide : sa politique doit être redérivée du payload réel.
