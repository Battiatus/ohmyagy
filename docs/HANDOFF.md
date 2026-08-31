# Handoff — 30 août 2026

Point de reprise pour la prochaine session. Lire [ADR-002](architecture/ADR-002-orchestration-plane.md) en premier.

## État au 30 août 2026, fin de session

ADR-002 en est à la **révision 4.1**, non ratifiée. La révision 3 est conservée
en `docs/architecture/.ADR-002.rev3.bak`.

**La révision 4 a été rejetée** par Codex `gpt-5.6-sol` (session
`01a05292-8cc7-7480-9f0f-4fbe586a7acd`), avec six blocages, tous mécaniques —
plus rien de conceptuel. Deux rendaient la spécification **inconstructible** et
sont corrigés en 4.1 :

- **Attestation de revue causalement impossible.** Le sujet était dérivé des
  transactions promues, donc du `commitSha`, tout en exigeant une attestation
  antérieure à la promotion. Corrigé : le sujet est la transaction **stagée**,
  identifiée par `stagedDiffDigest`, et la promotion est refusée si
  `diffDigest` diffère de `stagedDiffDigest`. Le reviewer a donc vu, octet pour
  octet, ce qui est promu — strictement plus fort que ce que la révision 4
  prétendait. ADR §6.2, §7.4, §7.5.
- **`LeaseRegister` comme second magasin durable.** Un verrou donne l'exclusion
  mutuelle, pas l'atomicité de crash entre deux stockages. Corrigé : le registre
  devient une **projection du journal signé**, sans état durable propre. Le
  problème disparaît au lieu d'être arbitré. ADR §5.2, §6.4.

Corrections annexes rendues gratuites par le même verdict : invariants `I8`,
`I9`, `I10` — `dispatch_refused + promotion_lost` était légal, un
`run_completed` pouvait porter des états non terminaux, et `criteria[]` pouvait
contredire tout `evaluation` autre qu'`approved` ; et la règle d'épingle §6.4,
qui diagnostiquait à tort un rollback sur un crash légitime.

Les **quatre blocages restants sont assumés comme dette déclarée**, ADR §19,
chacun rattaché au critère §15 qui le fera exploser : traçage d'observation
incomplet (`Object.keys`, `Reflect.ownKeys`, identité d'objet échappent au
`observedUpstream`), `missionClass` déclarée et non dérivée des effets, job
object Windows qui ne tient pas la revendication « unique tube duplex » après
évasion de realm, calibration et épingle co-gouvernées.

Critères d'acceptation : 29 en révision 3, **44 en révision 4.1** (43 numérotés
plus 21bis). ADR : 518 puis 1291 lignes. Section 18 : six points ouverts en
révision 3, quatre désormais, aucun bloquant.

## Construction — rangs 1 et 2 faits

L'ordre de construction est fixé en ADR §19.7, tel que proposé par Codex :
chaque rang tue un risque de conception au plus tôt.

**Rangs 1 et 2 construits et vérifiés indépendamment** (session Codex
`01a052a1-5e94-75a2-b090-7074d68d217f`, non commitée) : le chemin de revue sur
transaction stagée. Critères **19, 20, 21, 21bis** passent sur de vraies
transactions Git.

- `npm run build` : exit 0.
- `npm test` : 74 tests, 73 pass, 0 fail, 1 skip préexistant (symlink `EPERM`
  Windows). Exécuté localement, jamais en sandbox.
- Scan anti-bâclage sur les nouveaux répertoires : aucun `TODO`, `FIXME`,
  `@ts-ignore`, `test.skip`, `.only`, `: any`.
- `src/graph/` non touché par cette tranche.

Substrat livré : `src/broker/{staging,promotion,staged-review}.ts`,
`src/ledger/mission-journal.ts`, `src/oracle/{review,coverage}.ts`,
`src/policy/registry.ts`, `src/runtime/review.ts`, `src/orchestration/model.ts`
et sa suite de tests.

**Rien de la révision 4.1 ne s'est révélé impossible à l'implémentation.**
Quatre ambiguïtés ont exigé une convention ; elles ont été remontées dans l'ADR
et y sont désormais normatives : octets du diff unifié canonique (§6.2),
sérialisation de `subjectDigest` (§7.4), rapport entre `reviewerRunKey` et
`runKey` (§7.4), statut du critère 20 comme défense en profondeur de l'oracle
(§15).

Le journal de cette tranche est append-only et in-process. Signature,
persistance durable et custody restent hors périmètre : rangs 3 à 8.

## Décisions de méthode en vigueur

Décision de l'auteur, 30 août : **le runtime n'impose aucune étape de revue ;
un script peut omettre un reviewer.** La révision 4.1 conserve cette liberté
mais rend la couverture obligatoire par classe de mission, donc non annulable
par simple oubli de déclaration.

Décision de méthode : **construction du squelette quel que soit le verdict
résiduel**. Trois jours de gouvernance sans une seule invocation `agy`
suffisaient. Le verdict REJECT de la révision 4 n'a pas arrêté la construction ;
seules les deux impossibilités mécaniques ont été corrigées d'abord, parce que
bâtir une spécification impossible n'est pas construire.

## Historique de la décision

ADR-002 proposait de déplacer le plan dans un script et de faire du graphe un
journal. **Rejeté** par l'auteur, puis par deux challenges Codex `gpt-5.6-sol`
(stop-gate BLOCK, challenge neuf axes REJECT).

Raison centrale : un script écrit par un LLM peut soumettre des critères
d'acceptation vides, choisir des gates faibles ou terminer tôt, et
`mission_completed` n'a pas d'oracle. Le raccourci du modèle est déplacé d'un
étage, pas supprimé.

**ADR-001 reste en vigueur par défaut**, faute de remplaçant ratifié — bien que
Codex le juge fatal sans moteur de révisions. Le projet n'a donc pas de plan de
contrôle ratifié. C'est le premier point à traiter.

Direction d'amendement retenue : le script référence des `acceptance` et des
`gateId` issus du catalogue d'experts et du registre de gates, versionnés et
écrits par un humain ; il ne les rédige jamais. Les neuf décisions bloquantes
sont listées dans ADR-002.

## État vérifié du dépôt

- Dépôt Git initialisé, branche `master`, un commit `b9fc306`, suivi de
  `origin/master`.
- `npm run build` : exit 0.
- `npm test` : 70 tests, 69 pass, 0 fail, 1 skip conditionné à un défaut de
  privilèges (création de symlink), exécuté localement et non en sandbox.
- `node dist/bin/oma.js graph status` : `valid: true`, graphe v1 intact.
- Scan anti-bâclage sur `src/graph` et `src/oracle` : aucun `TODO`, `FIXME`,
  `@ts-ignore`, `test.skip` nu, `.only` ou `: any`.

## Travail non commité

Rien n'est commité. L'arbre de travail contient :

- `src/graph/model.ts` — `schemaVersion: 1 | 2`, contrat de nœud (`scope`,
  `acceptance`, `artifacts`, `maxDiff`), `acceptance[].gateId` au lieu d'une
  commande exécutable, validation lexicale de chemins.
- `src/graph/gate-registry.ts` (nouveau) — registre de gates externe,
  fail-closed, résolu par nœud.
- `src/graph/paths.ts` (nouveau) — containment realpath, rejet des symlinks et
  jonctions.
- `src/graph/store.ts` — câblage du registre ; refuse tout graphe porteur de
  contrat tant que l'enforcement n'existe pas.
- `src/graph/__tests__/graph.test.ts` — 16 tests ajoutés.
- `dist/` correspondant.

**Codex classe ce lot `high` et recommande de ne pas le livrer en l'état** : un
contrat parsé que la vérification refuse systématiquement est de l'effort hors
chemin critique. Deux options avant commit : compléter l'enforcement bout en
bout, ou retirer les champs de contrat jusqu'à ce qu'une tranche verticale les
consomme.

## Verdicts Codex de la session

1. Bypass de chemins drive-relative Windows (`C:foo`) — **corrigé**, 6 tests.
2. Contrat parsé jamais appliqué, gates exécutables fournies par le graphe,
   absence de version de schéma, containment contournable par symlink —
   **adressés** par la tâche A.
3. Registre de gates sélectionnable par `OMA_GATES_PATH` sans contrainte,
   TOCTOU dans `resolveRepoPath`, refus de contrat porté par l'appelant plutôt
   que structurel, divergence `.` entre parser et resolver — **ouverts**,
   latents tant qu'aucun consommateur n'exécute ces gates.
4. Revue produit : orchestration de sous-agents à 0 %, ADR-001 fatal sans
   moteur de révisions, arêtes incapables de transporter l'état, contrat
   inutilisable au runtime.

## Prochaine unité de travail

L’ordre autoritatif est désormais **ADR §19.7**, et ses rangs 1 et 2 sont
faits. La liste ci-dessous reste valide comme inventaire du substrat non encore
construit, pas comme ordre de priorité.

Tranche verticale exécutable, dans cet ordre :

1. Catalogue d'experts dans le bundle plugin : orchestrateur, planner,
   explorer, executor, reviewer, verifier. Zéro aujourd'hui.
2. Driver `agy -p --agent <expert> --output-format stream-json`, borné, avec
   sélection tardive du modèle et de l'effort, timeout, sorties terminales
   structurées.
3. Enveloppe de run typée transportant entrées, sorties, artefacts, feedback et
   parent causal entre sous-agents.
4. Script d'orchestration exécutant un fan-out/fan-in réel, avec validation par
   gate externe de chaque retour.
5. Scénario authentifié : deux agents parallèles, fan-in, validation en échec,
   correction, interruption, reprise, gate finale.
6. Benchmark contre Antigravity nu, modèles identiques.

## Dettes connues, non bloquantes

- `hooks.json`, `mcp_config.json` et `gates.json` contiennent des chemins
  absolus Windows en dur ; le bundle n'est pas distribuable en l'état.
- `gate-registry.ts` exige un `program` absolu existant, ce qui durcit la
  sécurité et cimente la non-portabilité.
- `.oma/control` est un spike archivé ; sa capacité d'invalidation de preuve
  par hash d'entrées (`inputHashBefore`/`inputHashAfter`, statut `stale`) n'a
  pas été reportée dans le kernel. C'est une régression à récupérer.
- `codex-companion cancel` échoue sous Windows : il passe `taskkill /PID` à
  travers Git Bash, qui traduit `/PID` en chemin.

## Protocole de supervision retenu

Toute analyse et tout lot de code passent par `/codex:adversarial-review`. Un
verdict `needs-attention` bloque le commit. Chaque finding Codex est converti
en gate déterministe : Codex découvre, les tests interdisent. La suite complète
est exécutée localement, jamais dans le sandbox Codex, dont les `mkdtemp`
échouent en EPERM.
