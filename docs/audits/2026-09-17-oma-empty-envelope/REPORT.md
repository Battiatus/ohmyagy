# Revue OMA — « rien ne se produit sur les modèles normaux »

Date : 17 septembre 2026. Code audité : branche `dev`, à partir de `fcd8f38`.
Binaire réel : `agy.exe` 1.2.5 (`C:\Users\User\AppData\Local\agy\bin\agy.exe`).

## Symptôme rapporté

Lancer OMA sur AntiGravity « normal » (2.0 / CLI) ne produit rien, et les
sessions se mélangent entre projets.

## Ce qui a été mesuré, pas supposé

### 1. La cause de « rien ne se produit » : une enveloppe de succès vide

Un appel réel du driver (`OMA_REAL_AGY=1 bun test
src/runtime/__tests__/agy-driver.real.test.ts`) rendait, **avant correctif** :

```json
{
  "conversation_id": "a8daad03-daa0-4be4-86da-643f30c3c1c4",
  "status": "SUCCESS",
  "response": "",
  "num_turns": 1,
  "duration_seconds": 89.19,
  "usage": { "total_tokens": 94935 }
}
```

Preuve hôte corrélée, `~/.gemini/antigravity-cli/log/cli-20260917_084207.log:242` :

```
W0917 08:45:11 poll.go:204] Print mode: print timeout after 3m0s with turn in
progress after 7085 polls (printed=14)
```

Autrement dit : `agy -p` a atteint son `--print-timeout` **pendant qu'un tour
d'outil était encore en cours**, est sorti avec le code 0, et a émis une
enveloppe `status:SUCCESS` dont le champ `response` est **vide**.

`AgyDriver.invoke` appelait `unwrapAgyResponse`, qui, sur une `response` vide non
JSON, **retournait l'enveloppe entière** comme `parsedOutput`. `parsed !==
undefined` ⇒ le driver classait la course en `success`. En aval :

- `real-mission.ts` : le planner « réussit » avec un plan vide ⇒ 0 work item ⇒
  mission `failed` sans qu'aucun travail réel n'ait eu lieu ;
- `dispatch-tools.ts` : un nœud est marqué `succeeded` alors que l'expert n'a
  rien produit ;
- `dynamic-engine.ts` : un diff vide passe en intégration.

C'est exactement « rien ne se produit » : la façade dit succès, le contenu est
vide.

### 2. Le mélange entre sessions : le projet AGY persistant par défaut

`agy -p` sans `--new-project` rattache chaque course au projet persistant
`default-cli-project` (`server.go:1145` `Conversation using project ID:
default-cli-project`, même log). Une course lancée depuis un worktree temporaire
hérite donc de l'état de conversation, des grants de permission et des skills
d'un projet sans rapport — un vecteur de contamination inter-sessions **côté
AGY**, distinct de l'attribution du Brain (déjà durcie, cf. audits des 09-14 et
09-16).

## Correctifs (delta minimal)

1. `src/runtime/agy-driver.ts`
   - `isEmptyAgySuccessEnvelope()` : une enveloppe `status:SUCCESS` à `response`
     vide est détectée et traitée comme un échec (`parseError`), jamais comme un
     résultat. Le nœud n'est plus marqué réussi sur du vide.
   - `buildCliArguments()` ajoute `--new-project` : chaque course OMA reçoit un
     projet AGY isolé, plus d'héritage du `default-cli-project`.

2. Régressions ciblées, `src/runtime/__tests__/driver.test.ts` :
   - `--new-project` attendu dans les deux jeux d'arguments canoniques ;
   - un nouveau test prouve qu'une enveloppe `SUCCESS`/`response:""` est
     classée `failed` avec le motif « empty response ».

3. `src/orchestration/__tests__/real-mission.e2e.test.ts` : la fixture committe
   le `.gitignore` écrit par `installWorkspacePlugin` avant de lancer la mission.
   Le garde « workspace Git propre » de `real-mission.ts` est un comportement
   produit correct ; la fixture le violait par ordre d'opérations.

## Preuves d'exécution réelle

| Preuve | Commande | Résultat |
|---|---|---|
| Driver réel réussit maintenant | `OMA_REAL_AGY=1 bun test .../agy-driver.real.test.ts` | **1 pass** (avant : fail, `response:""`) |
| Régressions driver | `bun test src/runtime/__tests__/driver.test.ts` | 14 pass |
| Suite complète | `npm run test` | 469 pass, 3 skip, 0 fail |
| Mission multi-agents réelle bout-en-bout | `OMA_REAL_AGY=1 bun test .../real-mission.e2e.test.ts` | **1 pass** (252 s) — planner → dispatch → worktree isolé → executor → review → gate → palette MCP réelle |

Extrait de la course réelle (preuve que l'enveloppe vide est désormais un échec
honnête, plus un faux succès) :

```
[OMA:Executor] Execution failed (failed): ... AGY returned a successful
  envelope with an empty response
[OMA:Mission] Mission BUDGET_EXHAUSTED (waves: 1, commits: 0, diagnostics: 1)
[E2E] real mission outcome: report=budget_exhausted palette=failed commits=0
```

La palette MCP (`mission_status`/`mission_inspect`/`list_missions`), lue via le
**vrai** broker sur stdio, reflète fidèlement cet état terminal — jamais un
verdict forcé.

## Limites de validation

- La cause d'AGY (timeout d'impression avec tour en cours) est intrinsèque à
  `agy -p` sur une tâche longue ; le correctif la rend **honnête** (échec au lieu
  de faux succès), il ne l'empêche pas. Une tâche qui dépasse `--print-timeout`
  échouera — correctement — au lieu de simuler un succès.
- La contamination inter-sessions **côté Brain** relevait d'audits antérieurs et
  reste couverte par l'attribution par preuve ; ce correctif ferme le canal AGY
  `default-cli-project`, complémentaire.
