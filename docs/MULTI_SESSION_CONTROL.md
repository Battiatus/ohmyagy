# Contrôle multi-session historique

> Ce document décrit le spike de contrôle antérieur. Depuis ADR-001, cette
> surface est archivée et n'est plus le control plane. La reprise autoritative
> utilise `oma graph status`, qui reconstruit le DAG exclusivement depuis
> `.oma/graph/execution-graph.json` et `.oma/graph/events.jsonl`.

Ce projet ne reprend jamais son travail depuis un résumé narratif. La source de
vérité locale est composée de quatre éléments :

1. `.oma/control/mission.json` fixe l'objectif et les critères d'acceptation.
2. `.oma/control/task-graph.json` fixe les dépendances et les commandes de preuve.
3. `.oma/control/ledger.jsonl` enregistre les résultats dans une chaîne de hashes.
4. `oma control handoff` reconstruit l'état courant à partir de ces fichiers et
   invalide toute preuve dont les entrées ont changé.

## Reprise obligatoire

Depuis la racine du dépôt :

```powershell
npm run build
node dist/bin/oma.js control verify
node dist/bin/oma.js control handoff
```

Une nouvelle session doit s'arrêter si `verify` retourne un code non nul. Elle
ne choisit pas librement sa tâche : elle prend uniquement `nextTask` dans le
résultat de `handoff`. Une tâche n'est `accepted` que lorsque toutes ses checks
ont une preuve fraîche, liée aux hashes actuels du contrat, du graphe et de ses
fichiers suivis.

Pour produire une preuve :

```powershell
node dist/bin/oma.js control run-check <TASK_ID> <CHECK_ID>
```

La sortie standard, la sortie d'erreur, le code de retour, les hashes d'entrée
et le hash de l'événement sont conservés. Une modification ultérieure d'une
entrée rend la preuve `stale` et bloque les tâches dépendantes.

## Ce que le système empêche déjà

- déclarer une tâche terminée uniquement dans un message ;
- réutiliser une ancienne preuve après modification du code ou du graphe ;
- ignorer une dépendance non acceptée ;
- masquer un échec de commande dans le ledger ;
- modifier discrètement un événement historique sans casser la chaîne de hashes ;
- autoriser l'agent strict à appeler directement les outils d'écriture, le shell
  ou un MCP de mutation autre que le broker OMA.

## Limite de confiance actuelle

Le handoff local reste volontairement signalé `detect-only`, car
`.oma/control/ledger.jsonl` est dans le workspace. `LEDGER-001` ajoute une
autorité Ed25519 dans un processus séparé, un état externe au workspace et une
tête épinglée dans un second emplacement. La reprise forte utilise alors :

```powershell
$env:OMA_AUTHORITY_STATE_DIR = '<répertoire externe en lecture seule pour l’agent>'
$env:OMA_AUTHORITY_PIN_PATH = '<fichier de tête épinglée hors authority state>'
node dist/bin/oma.js control handoff-authority
```

Le handoff signé refuse une signature invalide, une troncature du ledger, une
tête périmée, des champs non signés ou un état externe corrompu. Le processus de
signature conserve toutefois sa clé privée uniquement en mémoire : après son
arrêt, l'état reste vérifiable mais ne peut pas recevoir de nouvelles preuves.
Une autorité durable avec coffre de clés est donc un travail de produit, hors de
ce spike.

## Blocages externes connus

- Le répertoire courant n'est pas un dépôt Git. La promotion réelle est validée
  par les tests MCP dans des dépôts Git temporaires ; la QA CLI live démontre
  donc le rejet fail-closed `Not a Git repository`, pas une promotion dans ce
  checkout.
- `LIVE-001` a été observée avec `agy 1.1.22` authentifié, sans bypass global de
  permissions. La trajectoire et la base de conversation sont épinglées par
  SHA-256 dans `test-fixtures/live/agy-cli-audit.json` et vérifiées par
  `npm run test:live`.
- Un hook global tiers `googlecloudtools.datacloud_telemetry` est actuellement
  incompatible avec le parser de commandes de la CLI Windows. Il a été déplacé
  uniquement pendant la QA puis restauré ; OMA ne le modifie pas durablement.
- Le runner CLI Windows ne dépouille pas correctement les guillemets des chemins
  de hooks. L'installeur OMA émet donc des chemins absolus sans guillemets et
  refuse explicitement les chemins contenant des espaces.

## Règle de rapport

Chaque transmission de session doit reporter au minimum : `contractHash`,
`graphHash`, `ledgerHead`, les tâches `accepted`, `nextTask`, les preuves
manquantes ou périmées et les blocages externes. Un texte qui ne peut pas être
reconstruit par `oma control handoff` n'a aucune autorité sur l'état du projet.
