# ADR-002 : Le script ordonnance, le catalogue juge, le journal fait autorité

## Statut

Révision 4.2, 30 août 2026. Non ratifiée.

Révision 4.2, amendement d'une ligne de force, décidé par l'auteur le 30 août
après revue du code des rangs 1 et 2 : la promotion est **refusée** en
l'absence de revue approuvée antérieure quand la politique de classe l'exige.
La révision 4.1 laissait le commit non revu atterrir puis faisait échouer la
mission ; `seq(a) < seq(t)` n'y était qu'un constat. Le runtime n'impose
toujours aucune étape — il refuse un effet. §1, §7.5.1, critères 21ter et
21quater.

La révision 4 a été rejetée par Codex `gpt-5.6-sol` (session
`01a05292-8cc7-7480-9f0f-4fbe586a7acd`). Deux de ses six blocages rendaient la
spécification **inconstructible** et sont corrigés ici, sans attendre une
révision 5 :

- **Attestation de revue causalement impossible.** Le sujet était dérivé des
  transactions *promues*, donc du `commitSha`, tout en exigeant une attestation
  *antérieure* à la promotion. Le sujet est désormais la transaction **stagée**,
  et la promotion est refusée si le diff promu diffère d'un octet du diff
  attesté. §6.2, §7.4, §7.5.
- **`LeaseRegister` comme second magasin durable.** Un verrou donne l'exclusion
  mutuelle, pas l'atomicité de crash entre deux stockages. Le registre devient
  une **projection du journal signé**, sans état durable propre. §5.2, §6.4.

Les quatre blocages restants sont recensés en §19 et assumés comme dette
déclarée : la construction du squelette commence sans eux.

Historique : révision 1 rejetée par l'auteur et par Codex `gpt-5.6-sol`
(stop-gate BLOCK, challenge REJECT, neuf décisions requises). Révision 2 :
trois contradictions historiques fermées, deux décisions sur neuf fermées,
REJECT avec six blocages. Révision 3 : six blocages tranchés, REJECT avec cinq
trous mécaniques. Révision 4 ferme ces cinq trous :

1. identité de Run non portée par l'instance de mission et déduite de
   compteurs d'exécution — §3 ;
2. crash pré-`spawn` et post-`spawn` observationnellement indistinguables, donc
   protocole de reprise insatisfiable — §5, §6 ;
3. couverture sans règle d'applicabilité obligatoire ni lien vérifiable
   reviewer vers sujet — §1, §7, §12, §13 ;
4. effets de bord du broker non fencés par époque, frontière d'exécution du
   script non concrète — §4, §5, §6 ;
5. calibration de gates, invariants de statuts et custody de la clé de
   signature incomplets — §7, §9, §12.

Document normatif. Tout comportement non spécifié est interdit jusqu'à
amendement écrit. La section 18 énumère ce qui reste ouvert ; ces points ne
doivent pas être comblés par inférence.

## 1. Séparation des pouvoirs, et sa limite assumée

Le script ordonnance. Il ne juge pas. Les critères d'acceptation et les gates
sont résolus par le runtime depuis le catalogue et le registre, écrits par un
humain et versionnés. Le script ne peut ni les fournir, ni les modifier.

**Limite assumée par décision de l'auteur, 30 août 2026 :** le runtime
n'impose aucune étape. Un script peut omettre un reviewer, choisir un Expert
faible, ordonner comme il veut, terminer tôt. La séparation des pouvoirs vaut
au niveau du jugement, pas du workflow.

**Correctif de révision 4.** La contrepartie de la révision 3 — « la couverture
est un critère d'acceptation de mission » — ne mordait que si un humain avait
pensé à la déclarer. Une garantie qu'on annule en oubliant de la demander n'est
pas une garantie.

La couverture devient **obligatoire par classe de mission**. Toute mission
déclare une `missionClass`. Un **registre de politique**, écrit par un humain,
versionné, dont le digest entre dans le `MissionBundle`, associe à chaque
classe un ensemble de critères de mission requis. Le runtime évalue l'**union**
des critères déclarés par l'humain et des critères requis par la politique de
la classe ; l'humain peut ajouter, jamais retrancher. Une `missionClass` absente
du registre interdit le démarrage.

Un script libre d'omettre reste libre. Une mission de classe `code-change`,
dont la politique exige « toute transaction promue est le sujet d'un Run
reviewer approuvé, attesté avant promotion », échoue à la fin si le script a
omis — que l'humain y ait pensé ou non.

**Correctif de révision 4.2 : refuser l'effet, pas imposer l'étape.** La
révision 4.1 laissait la promotion libre et confiait tout à l'oracle de
mission. Un script omettant le reviewer promouvait quand même, et la mission
échouait *après* que le commit non revu eut atterri sur la branche. La
condition `seq(a) < seq(t)` n'était alors qu'un constat rétrospectif, pas une
protection : elle n'empêchait pas une mutation non revue d'exister.

Pour toute classe dont la politique porte un critère de couverture de famille
`review-of-every-promotion`, le broker **refuse la promotion** en l'absence
d'une attestation approuvée antérieure portant le `stagedDiffDigest` visé
(§7.5). La distinction qui préserve la décision de l'auteur est celle-ci :

- le runtime n'impose toujours **aucune étape** — il ne convoque pas de
  reviewer, ne réordonne rien, n'insère rien dans le script ;
- il refuse un **effet** — omettre le reviewer reste permis, et signifie
  désormais qu'aucune transaction n'est promue, au lieu d'en promouvoir une
  puis d'échouer.

Le script conserve sa liberté d'ordonnancement et d'omission. Ce qu'il perd,
c'est le droit de muter le dépôt sans revue quand la classe de la mission
l'exige.

| Pouvoir | Détenteur | Écrit par |
|---|---|---|
| Ordonnancement, boucles, fan-out, omissions | Script | LLM orchestrateur validé, ou humain |
| Critères d'acceptation, gates, périmètres | Catalogue et registre de gates | Humain |
| Critères de mission requis par classe | Registre de politique | Humain |
| Verdict de Run | Oracle | Code déterministe |
| Verdict de mission, couverture comprise | Oracle de mission | Code déterministe |
| Budget, baux, révocation | Scheduler | Humain, à la déclaration de mission |
| Autorité sur ce qui a eu lieu | Journal signé | Personne, append-only |

## 2. Vocabulaire normatif

| Terme | Définition |
|---|---|
| `Mission` | Objectif utilisateur, avec critères de mission déclarés par un humain et complétés par la politique de classe. |
| `MissionClass` | Étiquette résolue dans le registre de politique, déterminant les critères de mission requis. |
| `MissionBundle` | Ensemble figé : script, digests du catalogue, du registre de gates et du registre de politique, version de la table de résolution, classe, critères déclarés, arguments. |
| `MissionEpoch` | Génération de propriété de la mission. Un seul propriétaire par époque. |
| `Script` | Programme JavaScript restreint qui ordonnance. Il ne juge rien. |
| `CallSite` | Identité lexicale d'un site d'appel d'orchestration, attribuée à la validation statique. |
| `Expert` | Rôle du catalogue : outils, classe de modèle, effort, périmètres et critères par nature de tâche. |
| `Run` | Une invocation `agy` unique, identifiée par `runKey`. Jamais reprise. |
| `Lease` | Autorisation de dispatch à usage unique, débitée avant invocation, portant l'époque et un jeton porteur révocable. |
| `LeaseRegister` | Table durable `runKey` vers bail vivant. Autorité unique sur ce qu'un enfant a le droit de faire. |
| `Artifact` | Contenu produit, persisté hors journal, référencé par hash et provenance. |
| `Gate` | Commande déterministe du registre, de classe `structural`, `provenance`, `semantic` ou `coverage`. |
| `ReviewAttestation` | Lien typé, écrit par l'oracle, entre un Run reviewer et le sujet exact qu'il a reçu. |
| `Verdict` | Résultat d'oracle, avec un résultat par critère. |
| `Journal` | Suite append-only chaînée par hash, tête signée par une autorité à clé persistante et identité épinglée. |
| `AuthorityId` | `sha256` de la clé publique de l'autorité de signature. |

## 3. Identité de mission et de Run

La révision 3 dérivait l'identité d'un Run de compteurs d'exécution inférés et
omettait l'instance de mission. Deux missions distinctes portant le même bundle
produisaient les mêmes `runKey`, et la réconciliation par trailer de commit
pouvait se rattacher au commit d'une autre mission. La révision 4 remplace
l'inférence par une identité allouée, persistée, portée par l'instance.

### 3.1 Mission

`missionHash = sha256(canonicalJson(MissionBundle))`.

```
MissionBundle {
  scriptSha256, expertCatalogDigest, gateRegistryDigest,
  policyRegistryDigest, resolverTableVersion: string
  missionClass: string
  missionAcceptance: { id, description, gateId }[]
  limits: { maxRuns, maxAttemptsPerPath, maxTotalTokens, maxWallClockMs }
  args: unknown
}
```

JSON canonique : clés triées, UTF-8, LF, sans espace superflu.

`missionId` est un UUIDv7 attribué à la création, immuable, **hors**
`missionHash` : le hash identifie le bundle, l'identifiant identifie
l'instance. Les deux entrent dans `runKey`. `missionHash` sert au rejeu et à la
comparaison de bundles ; il ne sert jamais seul à retrouver un Run.

### 3.2 Identité lexicale des sites d'appel

À la validation statique, le runtime parcourt l'AST du script et attribue à
chaque expression d'appel de `runExpert`, `parallel` et `pipeline` un
`callSiteId = "c" + ordinal`, l'ordinal suivant l'ordre de parcours préfixe de
l'AST. Le script étant figé par `scriptSha256`, la table est stable et
reproductible. Elle est journalisée dans `mission_started` sous
`callSiteTable: { callSiteId, kind, span }[]`.

Deux sites d'appel mutuellement exclusifs portent donc des identités
distinctes, qu'ils s'exécutent au même rang ou non. L'ordinal lexical remplace
l'ordinal dynamique de la révision 3.

### 3.3 Chemin d'invocation

`invocationPath` est une suite de segments, de la racine au Run :

```
segment     := <callSiteId> "#" <occurrence> [ ":" <coordonnée> ]
coordonnée  := "p" <positionDansLeTableau>          // cadre parallel()
             | "s" <indexEtape> "." <indexItem>     // cadre pipeline()
```

`occurrence` est un entier alloué par le runtime, monotone, de portée
`(invocationPath du cadre parent, callSiteId)`. Une boucle qui rappelle le même
site dans le même cadre incrémente `occurrence`. Une récursion change le chemin
parent, donc repart à zéro sans collision. Un appel de fonction ordinaire ne
crée pas de cadre et ne contribue aucun segment : seuls les sites d'appel
d'orchestration en créent, et ils sont tous identifiés.

Le compteur n'est **pas recalculé** à la reprise. `run_started` persiste
`invocationPath`, `parentInvocationPath`, `parentRunKey`, `callSiteId` et
`occurrence` ; à la reprise, les compteurs sont reconstruits par lecture du
journal, jamais ré-inférés de l'exécution.

`parallel()` ordonne par position dans le tableau fourni, `pipeline()` par
index d'étape puis d'item. Les deux ordres sont déterministes et ne dépendent
pas de l'ordre d'achèvement.

### 3.4 Empreinte d'entrée, non circulaire

```
RunInputCore {
  expertId, taskKind, objective: string
  inputs: string[]     // sha256 des ArtifactRef, triés
  messages: { role, from, text }[]
}

inputDigest = sha256(canonicalJson(RunInputCore))
```

`RunInputCore` **exclut** `runId`, `runKey`, `leaseId`, `epoch`, `resolved` et
tout champ de budget. La circularité de la révision 2 reste supprimée.

### 3.5 Dépendances amont observées

La révision 3 pliait `upstreamRunKeys` dans la clé. Une clé amont identique
peut recouvrir un résultat amont différent : un Run non déterministe rend un
verdict ou un message différent sous la même clé, et un aval qui branche
là-dessus sans le réinjecter dans ses entrées garde la même clé. La propriété
annoncée était donc fausse.

Le runtime remplace les clés amont par les **résultats effectivement
observés**.

Un `RunResult` rendu au script est un objet à prototype nul, gelé, dont chaque
accesseur enregistre la lecture. Le runtime tient, par cadre,
`observed: Set<resultHash>`, avec
`resultHash = sha256(canonicalJson(RunResult))` tel que journalisé. Un
`RunResult` seulement transporté sans lecture n'est pas observé ; lire un seul
champ suffit à l'être.

```
observedUpstream = trié( observed(cadre courant) ∪ observed(cadres ancêtres) )
                   restreint aux lectures antérieures à l'appel
```

C'est un sur-ensemble conservateur des dépendances de contrôle et de données.
Coût assumé : un cadre qui lit beaucoup de résultats invalide largement son
cache de rejeu. Correction avant économie.

### 3.6 Clé de rejeu

```
runKey = sha256(canonicalJson({
  missionId, missionHash, invocationPath, inputDigest, observedUpstream
}))
```

Propriétés, chacune adossée à un critère §15 :

- **Portée d'instance.** `missionId` étant dans la clé, deux instances du même
  bundle ne partagent aucun `runKey`. Le trailer de commit porte `oma-mission`
  et `oma-run` ; la réconciliation exige les deux.
- **Stabilité au branchement.** Un résultat amont différent, s'il est lu,
  change `observedUpstream` ; s'il est réinjecté, change `inputDigest`. S'il
  n'est ni lu ni réinjecté, il n'a pu influencer ni le flot ni le contenu.
- **Absence de collision entre sites exclusifs.** Les `callSiteId` diffèrent.
- **Stabilité en boucle et en récursion.** `occurrence` est alloué et persisté,
  pas déduit.

Reprise : un `runKey` déjà terminal au journal retourne son `RunResult`
enregistré sans redispatch.

## 4. Autorité du script et frontière d'exécution

### 4.1 Auteur

Un script peut être écrit par un LLM orchestrateur ou par un humain. Dans les
deux cas il est une donnée, validée statiquement avant exécution. Un script
invalide interdit le démarrage de la mission.

### 4.2 Frontière d'exécution, concrète

La révision 3 décrivait un realm gelé, ce qui contraint le langage mais pas le
processus. La révision 4 sépare les deux et n'annonce que ce qui est appliqué
par l'OS.

**Niveau 1, langage.** Le script s'exécute dans un realm gelé : intrinsèques
atteignables `Object.freeze` ; pas de `Function`, `eval`, `require`, `import`,
`import()`, `process`, `fs`, `child_process`, réseau ; capacités injectées
exposées comme objets à prototype nul, propriétés propres gelées ; `Date.now()`,
`Math.random()` et `new Date()` sans argument lèvent, pour préserver le
déterminisme du rejeu. Rejets à la validation statique : `constructor`,
`__proto__`, `with`, import dynamique, et tout accès membre calculé sur une
capacité injectée.

**Niveau 2, processus.** Le script s'exécute dans un processus dédié, distinct
du scheduler, du broker et de l'oracle, avec :

- répertoire de travail hors du worktree ; aucun chemin du dépôt dans son
  environnement ;
- aucun handle hérité hors du canal IPC ;
- environnement réduit à une liste blanche explicite, sans jeton, sans clé,
  sans `PATH` du dépôt ;
- sous Windows : job object avec `JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 1`,
  `BREAKAWAY_OK` désactivé, `KILL_ON_JOB_CLOSE` activé, jeton restreint privé
  d'écriture sur le worktree par ACL ; ailleurs : utilisateur dédié sans droit
  d'écriture sur le worktree.

**Niveau 3, capacités.** L'unique canal du processus script est un tube duplex
vers le broker. Toute demande y porte `{ runKey, leaseId, epoch, token }` et
est validée §5.3. Le script n'a aucune capacité qu'il n'ait reçue.

**Ce qui n'est pas garanti, et doit être dit :** il n'y a pas d'isolation
noyau. Une évasion du realm JavaScript combinée à une élévation locale n'est
pas couverte. Le modèle de menace couvert est un script hostile ou incompétent
produit par un LLM, pas un attaquant disposant d'un exploit noyau. Le
confinement réel des mutations repose sur le niveau 3, pas sur le niveau 1.

### 4.3 Ce que le script ne peut pas fournir

`acceptance`, `gateId`, `scope`, `maxDiff` sont refusés s'ils apparaissent dans
un appel. Le runtime les résout depuis le catalogue via `expertId` et
`taskKind`.

### 4.4 Enveloppe de prompt, et sa portée réelle

Le runtime compose le prompt dans cet ordre :

1. **Bloc contrat** : périmètre résolu, critères d'acceptation, `maxDiff`,
   outils autorisés, règle de sortie structurée. Émis sur le canal de plus
   haute priorité offert par `agy`.
2. **Manifeste d'entrées** : `ArtifactRef` avec hash et provenance.
3. **Bloc données de tâche, marqué non fiable** : `objective` et `messages`
   fournis par le script, délimités, échappés, transmis comme données
   structurées et non comme instruction.

**Portée réelle, corrigée.** Délimiter un texte non fiable n'établit aucune
frontière d'autorité à l'intérieur du modèle. L'enveloppe améliore le guidage,
elle ne le contraint pas. L'Expert reste traité comme non fiable : accès aux
outils, périmètre, mutations, provenance et approbation sont tous appliqués
hors du modèle, par le broker et l'oracle. Aucun critère §15 ne repose sur
l'obéissance de l'Expert à son enveloppe.

Un Expert ne peut référencer qu'une entrée présente au manifeste. Une référence
hors manifeste rend le Run `evaluation = rejected`, code `unprovenanced_input`.

## 5. Baux, registre de baux, dispatch

### 5.1 Bail

```
Lease { leaseId, runKey, missionId, epoch, tokenHash,
        tokenCeiling, wallClockMs, attemptIndex, issuedAt }
```

Émis sous autorité scheduler, débité atomiquement avant dispatch, journalisé
`lease_issued`, **à usage unique et jamais réutilisé**. Toute nouvelle
tentative consomme un nouveau bail. Le jeton porteur en clair n'est transmis
qu'à l'enfant ; le journal n'en porte que le `sha256`.

Limites de mission obligatoires : `maxRuns`, `maxAttemptsPerPath`,
`maxTotalTokens`, `maxWallClockMs`. Dépassement : `mission_halted` avec code.
`budget` exposé au script est une projection en lecture seule.

### 5.2 Registre de baux vivants, projection du journal

La révision 4 faisait du `LeaseRegister` une table durable distincte du
journal. Un verrou donne l'exclusion mutuelle, pas l'atomicité de crash entre
deux stockages : un arrêt entre l'append de `lease_revoked` et la persistance
du registre laisse l'histoire signée dire « révoqué » et l'autorité d'effet
dire « live ». Inverser l'ordre produit la divergence symétrique.

Le registre n'a donc **aucun état durable propre**. Il est une projection,
reconstruite par pliage du journal signé :

```
LeaseRegister : runKey → { leaseId, epoch, tokenHash, state: "live" | "revoked" }

fold(journal) :
  lease_issued  { runKey, leaseId, epoch, tokenHash } → state = "live"
  lease_revoked { runKey, leaseId, epoch }            → state = "revoked"
```

Le journal signé est la seule source de vérité. Une copie en mémoire du pliage
est autorisée comme cache non autoritatif ; elle est reconstruite au démarrage
et après toute reprise, jamais lue depuis le disque comme un état indépendant.
Aucun magasin secondaire ne peut donc diverger du journal, et la question de
l'atomicité croisée disparaît au lieu d'être arbitrée.

Au plus un bail `live` par `runKey`. Émettre un bail pour un `runKey` qui en a
déjà un `live` est interdit sans `lease_revoked` préalable durable.

Conséquence sur §5.3 : la validation de capacité lit la projection, donc lit le
journal. Elle se fait sous le même verrou que l'effet, ce qui était déjà exigé.

### 5.3 Validation de capacité, appliquée à l'effet

Toute opération de broker et d'oracle — écriture d'artefact, staging,
promotion, évaluation de gate, append de tout événement — valide, **dans la
section critique qui produit l'effet** :

1. `epoch` de la requête égale l'époque durable courante ;
2. `LeaseRegister[runKey]` existe, est `live`, et son `leaseId` est celui de la
   requête ;
3. `sha256(token)` égale le `tokenHash` enregistré.

Un échec sur l'un des trois rend `capability_revoked` et n'a aucun effet.
Terminer l'arbre de processus est un nettoyage, jamais le mécanisme de
sécurité.

### 5.4 Dispatch

Avant tout `spawn`, le driver écrit `dispatch_intent { runKey, leaseId, epoch }`
et le rend durable. Le premier message structuré de l'enfant renvoie `runKey`
et fait office d'acquittement.

| Classe | Condition | Reprise |
|---|---|---|
| `dispatch_refused` | Échec **prouvé avant** l'écriture de `dispatch_intent` : bail refusé, exécutable introuvable, construction d'arguments invalide. | Nouvelle tentative, **nouveau bail**. |
| `acknowledged` | `runKey` renvoyé par l'enfant, sortie terminale parsée. | Sans objet. |
| `outcome_unknown` | `dispatch_intent` durable, puis ni acquittement ni sortie terminale. | Protocole §6.3, sans distinction pré ou post `spawn`. |

Il n'existe aucune reprise automatique fondée sur une hypothèse quant à
l'existence du processus enfant.

## 6. Reprise durable, époques, fencing

### 6.1 Époque

Le scheduler ouvre `mission_epoch_opened { epoch, ownerId }` à chaque prise de
propriété. Tout événement portant une époque périmée est refusé à l'append, et
toute opération de broker portant une époque périmée est refusée à l'effet
(§5.3). Un second processus de reprise incrémente l'époque et clôture le
précédent propriétaire.

La prise d'époque et la promotion prennent le **même** verrou exclusif de
mission, et l'époque est revalidée à l'intérieur. Aucune promotion ne peut donc
chevaucher une bascule d'époque.

### 6.2 États journalisés

`leased → dispatched → produced → staged → promoted → completed`.

Le broker écrit d'abord
`transaction_staged { runKey, missionId, leaseId, epoch, transactionId, stagedDiffDigest }`.
`stagedDiffDigest` est le `sha256` du diff unifié canonique de la transaction
stagée contre sa base, calculable **avant** tout commit. C'est cet identifiant
qui sert de sujet de revue.

**Diff unifié canonique, normatif.** La révision 4.1 laissait « canonique »
indéfini ; deux implémentations auraient produit deux digests, et la règle
d'identité ci-dessous n'aurait jamais pu être satisfaite. Définition fixée à
l'implémentation : algorithme Myers, détection de renommage désactivée, couleur
désactivée, `external diff` désactivé, index complet, diff binaire activé,
préfixes `a/` et `b/`. Le digest est le `sha256` des octets UTF-8 du résultat.
Cette définition vaut identiquement pour `stagedDiffDigest` et `diffDigest`.

Il écrit ensuite
`transaction_promoted { runKey, missionId, leaseId, epoch, transactionId, stagedDiffDigest, commitSha, diffDigest }`
et inscrit `oma-mission: <missionId>` et `oma-run: <runKey>` dans les trailers
du commit. `diffDigest` est le `sha256` du diff unifié canonique du commit
contre son parent.

**Règle d'identité de promotion, refusée si violée :** la promotion exige
`diffDigest = stagedDiffDigest`. Le commit promu est donc, octet pour octet, la
transaction qui a été stagée et attestée. Un écart interdit la promotion,
`transaction = conflict`, code `staged_promoted_mismatch`.

### 6.3 Réconciliation, sans hypothèse sur `spawn`

La révision 3 exigeait deux reprises différentes pour un crash avant `spawn` et
un crash après `spawn` sans acquittement, alors que les deux laissent
exactement le même préfixe de journal. C'était insatisfiable. La révision 4
supprime l'exigence de les distinguer et rend **la même action correcte dans
les deux cas**.

Séquence unique sur `dispatched` sans acquittement, tenue sous verrou :

1. Chercher un commit portant `(missionId, runKey)`. **Trouvé** : émettre
   `transaction_promoted` si absent, puis `run_completed`, avec
   `reasonCode = reconciled_from_journal`. Aucun redispatch, aucune invocation
   `agy`.
2. **Absent** : révoquer le bail (`lease_revoked`, §5.2). À partir de cet
   instant, un enfant orphelin éventuel est capacité-mort : ses appels broker
   et ses appends sont refusés (§5.3), qu'il existe ou non.
3. Rejeter le staging éventuel attaché à l'ancien bail.
4. Émettre un nouveau bail et redispatcher, si `maxAttemptsPerPath` le permet.

Cette séquence est correcte que le `spawn` ait eu lieu ou non, parce qu'elle ne
dépend d'aucune observation du processus enfant. La distinction que la
révision 3 exigeait n'est pas observable ; la révision 4 la rend inutile.

| État observé à la reprise | Action |
|---|---|
| `leased` sans `dispatched` | Révocation, nouveau bail, redispatch. |
| `dispatched` sans acquittement | Séquence §6.3. |
| `produced` sans `promoted` | Chercher un commit `(missionId, runKey)`. Trouvé : émettre `transaction_promoted` puis `run_completed`. Absent : jeter le staging, Run terminal `transaction = none`, code `promotion_lost`. |
| `promoted` sans `completed` | Ne jamais invoquer `agy`. Compléter depuis le commit. |
| état terminal | Retourner le résultat enregistré. |

### 6.4 Écriture concurrente

Writer unique par mission, verrou exclusif système tenu sur la séquence
complète : lecture de tête, calcul de hash, append, `fsync`, mise à jour de
tête, mise à jour de l'épingle. Le `LeaseRegister` n'apparaît pas dans cette
séquence : étant une projection (§5.2), il n'a rien à persister. Le verrou
n'est jamais tenu pendant une invocation `agy` : le parallélisme réel des Runs
est préservé.

Il reste **deux** objets durables, le journal et l'épingle, et un seul ordre
d'écriture : append puis `fsync` puis tête puis épingle. La fenêtre de crash
résiduelle laisse l'épingle en retard sur le journal, jamais en avance. Elle
est donc décidable : une tête dont le `seq` est **supérieur** à celui de
l'épingle et dont la chaîne de hash remonte jusqu'à `lastHead` épinglé est un
descendant valide, et l'épingle est rattrapée. Seuls un `seq` inférieur, ou une
chaîne qui ne remonte pas à `lastHead`, constituent un rollback
(`journal_rollback_detected`). Cette règle remplace la comparaison de hash
brute de la révision 4, qui diagnostiquait à tort un rollback sur un crash
légitime.

À la reprise, une dernière ligne partielle échouant à la vérification de hash
est tronquée ; toute incohérence ailleurs arrête la mission.

`parallel()` ne convertit en `RunResult` que les échecs de Run. Corruption de
journal, échec de verrou, époque périmée ou impossibilité de persister un
événement autoritatif arrêtent la mission.

## 7. Oracle

### 7.1 Natures

- `transactional` : broker plus gates, pour les Experts qui écrivent.
- `artifact` : gates sur les artefacts produits, dans un worktree en lecture
  seule, pour les Experts read-only.
- `journal` : gates sur le journal lui-même, réservées aux critères de mission,
  couverture comprise.

### 7.2 Classes de gates et force sémantique

| Classe | Ce qu'elle établit |
|---|---|
| `structural` | Forme : schéma, sections présentes, non-vacuité. |
| `provenance` | Traçabilité : chaque chemin cité existe, chaque plage de lignes citée contient le symbole revendiqué, chaque entrée utilisée figure au manifeste. |
| `semantic` | Contenu : test référencé présent et rouge avant puis vert après, arbitre indépendant à critères cachés, propriété vérifiable du résultat. |
| `coverage` | Composition de la mission, évaluée sur le journal. |

**Règle de force, refusée au chargement si violée :** tout Expert `readOnly`
doit porter au moins un critère de classe `semantic` ou `provenance`. Un
contrat purement `structural` est interdit.

Les gates de comptage — nombre de citations, nombre de sections — ne peuvent
pas être de classe `semantic` : elles récompensent le remplissage.

### 7.3 Calibration adverse

La révision 3 exigeait un jeu de fixtures superficielles connues. Un corpus
fixe et divulgué se sur-apprend : une gate peut rejeter les hashes connus et
approuver un artefact superficiel inédit. Une calibration uniquement négative
laisse aussi passer une gate qui rejette tout.

La révision 4 impose quatre conditions cumulatives, vérifiées au chargement du
registre :

1. **Corpus tenu à l'écart.** Le catalogue référence un `fixtureCorpusId` et
   son digest ; le contenu vit sous `oma/calibration/`, hors du périmètre de
   tout Expert, jamais inséré dans une enveloppe de prompt, jamais accessible
   au script.
2. **Contrôles positifs.** Chaque gate doit **approuver** au moins un cas connu
   comme bon par nature de tâche qu'elle couvre. Une gate qui rejette tout est
   refusée.
3. **Négatifs générés, non fixes.** Les cas superficiels sont produits à chaque
   chargement par un mutateur versionné et graine, à partir des cas bons, selon
   des classes de mutation déclarées : troncature du raisonnement, suppression
   des citations, substitution d'un symbole par un frère de même nom, section
   vidée, plage de lignes décalée, conclusion sans support. Le corpus effectif
   n'est donc pas un ensemble de hashes stable.
4. **Critères sémantiques, pas identitaires.** Le prédicat de refus d'une gate
   porte sur une propriété — « la plage citée ne contient pas le symbole
   revendiqué » — jamais sur l'identité d'une fixture.

Une gate qui approuve un cas muté, ou qui rejette un contrôle positif, est
refusée au chargement. Le jeu initial de classes de mutation par Expert est
fixé en §13.1.

### 7.4 Attestation de revue

Le lien entre un Run reviewer et ce qu'il a réellement examiné n'était pas
typé. `expertId` et `inputDigest` prouvent qu'un reviewer a tourné, pas qu'il a
reçu la transaction promue ni le diff complet.

**Sujet stagé, non promu.** La révision 4 dérivait le sujet des transactions
promues, donc du `commitSha`, tout en exigeant une attestation antérieure à la
promotion. Le sujet ne pouvait pas exister avant le commit qui le nommait : la
règle était insatisfiable. Le sujet est désormais la transaction **stagée**,
qui existe avant toute promotion et dont l'identité `stagedDiffDigest` est
liée au commit ultérieur par la règle d'identité de §6.2.

Un `taskKind` du catalogue peut porter `reviews: true`. Pour un tel Run, le
runtime :

1. exige que toute entrée du manifeste porte un `producedByRunKey` ;
2. dérive le **sujet** comme l'ensemble des transactions **stagées** de ces
   `runKey`, identifiées par `(runKey, transactionId, stagedDiffDigest)` ;
3. injecte lui-même, pour chaque transaction du sujet, un artefact
   `diff:<transactionId>` dont les octets sont le diff stagé canonique et dont
   `sha256 = stagedDiffDigest`, ajouté au manifeste : le reviewer reçoit le
   diff complet ou rien ;
4. écrit, à l'évaluation, sous autorité oracle :

```
review_attested {
  reviewerRunKey, missionId, epoch, leaseId,
  subject: { runKey, transactionId, stagedDiffDigest,
             artifactHashes: string[] }[]
  subjectDigest    // sha256 des stagedDiffDigest triés du sujet
  reviewerVerdict  // outcome du Verdict du reviewer
}
```

`subjectDigest = sha256(canonicalJson(stagedDiffDigest triés))`. La révision 4.1
nommait l'agrégat sans en fixer la sérialisation ; elle l'est ici.

`reviewerRunKey` est le seul identifiant de Run de l'attestation. Le `runKey`
que §12 ajoute aux charges utiles d'oracle lui est **égal** par construction
pour cet événement ; les deux champs coexistent pour uniformité du schéma
d'événement, et une divergence entre eux est refusée à l'append.

L'artefact injecté est un `ArtifactRef` complet au sens de §10 :
`id = "diff:" + transactionId`, `kind = "diff"`, `path` dans l'espace de
mission, `sha256 = stagedDiffDigest`, `bytes` la taille du diff canonique,
`producedByRunKey` le Run auteur de la transaction, `inputHashes` vide. Il
entre dans `inputs`, donc dans `inputDigest`, donc dans le `runKey` du
reviewer, comme toute autre entrée.

Le script n'écrit ni ne modifie cette attestation ; elle est dérivée du
manifeste et du journal.

### 7.5 Sémantique de la classe `coverage`

Une gate `coverage` est une formule universellement quantifiée sur le journal.
La politique de classe `code-change` exige au minimum :

```
∀ t ∈ transaction_promoted(mission) :
  ∃ a ∈ review_attested(mission) :
        (t.runKey, t.transactionId, t.stagedDiffDigest) ∈ a.subject
     ∧  a.reviewerVerdict = "approved"
     ∧  seq(a) < seq(t)                        // attesté avant promotion
     ∧  runOf(a.reviewerRunKey).expertId ≠ runOf(t.runKey).expertId
```

La formule est satisfaisable parce que `stagedDiffDigest` existe dès
`transaction_staged`, donc avant `transaction_promoted`, et parce que §6.2
interdit de promouvoir un diff différent de celui qui a été stagé.

### 7.5.1 Application à la promotion, non seulement au verdict

Cette formule ne s'évalue pas qu'en fin de mission. Quand la politique de la
classe porte un critère de famille `review-of-every-promotion`, le broker
évalue son antécédent **au moment de la promotion**, dans la section critique
qui produit l'effet, et refuse si aucune attestation ne le satisfait :

```
promotionAutorisée(t) ⟺
  ¬requiertCouverture(missionClass)
  ∨ ∃ a ∈ review_attested(mission) :
        (t.runKey, t.transactionId, t.stagedDiffDigest) ∈ a.subject
     ∧  a.reviewerVerdict = "approved"
     ∧  seq(a) < seq de la promotion tentée
     ∧  runOf(a.reviewerRunKey).expertId ≠ runOf(t.runKey).expertId
```

Refus : `transaction = rejected`, `reasonCode = unreviewed_promotion`. À
distinguer de `staged_promoted_mismatch`, qui rend `conflict` et signale un
diff altéré entre staging et promotion, pas une revue absente.

La gate `coverage` de mission subsiste et devient une **défense en profondeur**,
au même titre que le critère 20 pour l'oracle : elle rattrape toute promotion
qui aurait atteint le journal par un chemin autre que le broker. Le contrôle à
la promotion est per-transaction et empêche l'effet ; la gate est
mission-entière et constate. Les deux sont nécessaires, et aucun ne remplace
l'autre.

`requiertCouverture` est dérivé du registre de politique (§13.2), jamais du
script ni de l'Expert.

Ce que cette formule établit : chaque transaction promue a un reviewer
approuvé, portant un `expertId` distinct de l'auteur, qui a reçu exactement les
octets ensuite promus, avant qu'ils ne le soient.

Ce qu'elle n'établit pas, et qui doit être dit :

- que la revue ait été de qualité — cela relève des gates `semantic` du
  reviewer et du protocole §16 ;
- que le reviewer ait *consommé* le diff — le manifeste prouve la livraison,
  pas la lecture ; une gate `provenance` du reviewer doit l'établir ;
- que `expertId` distinct implique un modèle, une autorité ou un opérateur
  indépendants — c'est une distinction d'étiquette de catalogue ;
- qu'un changement sémantique éclaté en plusieurs transactions individuellement
  anodines soit revu dans son effet combiné.

Ces quatre limites sont reprises en §19 comme dette déclarée.

### 7.6 Résultat par critère

```
CriterionResult { id, gateId, gateClass,
                  outcome: "satisfied" | "unsatisfied" | "inconclusive" | "not_applicable",
                  observation }
```

`Verdict.outcome = "approved"` seulement si tous les critères sont
`satisfied`. Un `inconclusive` donne `Verdict.outcome = "inconclusive"`.

### 7.7 Échelle d'arbitrage

1. gate déterministe — seule autorité pouvant prononcer `approved` ;
2. Expert arbitre indépendant, read-only, classe de modèle différente, critères
   non communiqués au script — peut seulement dégrader ou marquer
   `inconclusive` ;
3. humain nommé — peut surcharger ; décision journalisée avec son identité.

### 7.8 Interdits d'oracle

Approbation vide interdite : un Expert sans critère ne peut pas atteindre
`succeeded`. `mission_completed` exige un `mission_verdict` contre l'union des
critères déclarés et des critères requis par la politique de classe. Le
scheduler ne peut pas l'émettre seul.

### 7.9 Fraîcheur des artefacts

`stale` est un état dérivé, calculé par l'oracle, non un champ librement
écrit :

```
stale(a: ArtifactRef) ⟺ ∃ h ∈ a.inputHashes :
    h ∉ { sha256 des ArtifactRef courants de même id }
```

Détection journalisée :
`staleness_detected { artifactId, expectedHashes, actualHashes }`. Un artefact
`stale` rend `not_applicable` tout critère qui s'appuie sur lui et ne peut
satisfaire aucun critère. Cette capacité est reprise du spike `.oma/control` et
n'existe pas encore dans le kernel.

## 8. Versions résolues par Run

`run_started` enregistre et `RunResult` reporte : `resolvedModelId`,
`resolverTableVersion`, `expertId`, `expertDigest`, `gateRegistryDigest`,
`policyRegistryDigest`, `runtimeVersion`, `agyVersion`.

À la reprise, une résolution divergente arrête la mission au lieu de
substituer.

## 9. Modèle de statuts

La révision 3 déclarait trois ensembles de valeurs autorisées et un produit
cartésien permissif, qui laissait passer des combinaisons incohérentes. La
révision 4 remplace le produit par une machine à états par axe, plus des
invariants croisés vérifiés à l'append.

```
execution:   dispatch_refused | dispatched | produced | timeout | crashed
             | cancelled | outcome_unknown
transaction: none | staged | rejected | promoted | conflict | promotion_lost
evaluation:  not_evaluated | approved | rejected | inconclusive
             | needs_adjudication | not_applicable
reasonCode:  string
criteria:    CriterionResult[]
```

### 9.1 Transitions par axe

```
execution:   (initial) → dispatch_refused ▮
             (initial) → dispatched → produced ▮
             dispatched → timeout ▮ | crashed ▮ | cancelled ▮ | outcome_unknown ▮

transaction: none ▮
             none → staged → rejected ▮ | conflict ▮ | promoted ▮ | promotion_lost ▮

evaluation:  not_evaluated ▮
             not_evaluated → approved ▮ | rejected ▮ | inconclusive ▮ | not_applicable ▮
             not_evaluated → needs_adjudication → approved ▮ | rejected ▮
```

`▮` marque un état terminal. `staged` n'est **pas** terminal : un Run ne peut
pas se clore en `staged`.

### 9.2 Invariants croisés, vérifiés à l'append

- **I1** `transaction = promoted ⟹ evaluation = approved`. Interdit
  `produced + promoted + rejected`.
- **I2** `transaction ∈ { rejected, conflict } ⟹ evaluation ∈ { not_evaluated, rejected }`.
  Interdit `produced + rejected + approved`.
- **I3** `transaction = staged` interdit dans un `run_completed`. Interdit
  `produced + staged + approved` comme Run clos.
- **I4** `evaluation = approved ⟹` il existe un `gate_evaluated` `satisfied`
  pour **chaque** critère résolu du contrat, **et**
  `transaction = promoted ∨ ∃ artifact_recorded(runKey)`. Interdit
  `outcome_unknown + none + approved`.
- **I5** `execution ∈ { dispatch_refused, dispatched, timeout, crashed, cancelled } ⟹ evaluation = not_evaluated`.
- **I6** `execution = outcome_unknown ∧ evaluation = approved ⟹`
  `transaction = promoted`, **et** le commit et l'intégralité des
  `gate_evaluated` sont durables au journal, **et**
  `reasonCode = reconciled_from_journal`. C'est la seule dérivation autorisée ;
  toute autre est refusée.
- **I7** `execution ∈ { timeout, crashed, cancelled } ⟹ transaction ∈ { none, promotion_lost }`.
- **I8** `execution = dispatch_refused ⟹ transaction = none`. Un dispatch
  refusé précède toute création de transaction, donc `promotion_lost` lui est
  interdit.
- **I9** Un `run_completed` ne peut porter que des états terminaux au sens de
  §9.1 sur les trois axes. `execution = dispatched` et
  `evaluation = needs_adjudication` sont donc interdits dans un `run_completed`,
  au même titre que `transaction = staged`.
- **I10** Cohérence de `criteria[]` sur tout l'axe `evaluation`, pas seulement
  sur `approved` : `approved` exige tous les critères `satisfied` ; `rejected`
  exige au moins un `unsatisfied` et aucun `inconclusive` ; `inconclusive`
  exige au moins un `inconclusive` ; `not_applicable` exige que tous les
  critères soient `not_applicable` ; `not_evaluated` exige `criteria[]` vide.

Toute combinaison ne satisfaisant pas §9.1 et §9.2 est refusée à l'append.

### 9.3 Étiquette dérivée

`succeeded` si et seulement si `execution = produced` **et**
`evaluation = approved` **et** `transaction ∈ { none, promoted }`.

Précédence de lecture : `execution`, puis `transaction`, puis `evaluation`. La
satisfaction partielle est portée par `criteria[]`, jamais par un statut
global. `needs_adjudication` est un état d'`evaluation`, pas un statut global.

## 10. Contrats de données

Hashes SHA-256 hexadécimaux minuscules sur 64 caractères. Horodatages ISO-8601
UTC. Tout champ non listé est refusé au parsing. `RunInput` porte
`contractVersion: 1`, espace de nommage indépendant du `schemaVersion` du
graphe hérité.

```
RunInput {
  contractVersion: 1
  missionId, runId, runKey, leaseId, epoch: string
  parentRunKey: string | null
  invocationPath, callSiteId: string
  occurrence: number
  expertId, taskKind, objective: string
  inputs: ArtifactRef[]
  messages: Message[]
  resolved: { modelId, resolverTableVersion, expertDigest,
              gateRegistryDigest, policyRegistryDigest,
              runtimeVersion, agyVersion }
}

RunResult {
  runKey: string
  execution, transaction, evaluation, reasonCode: string
  criteria: CriterionResult[]
  outputs: ArtifactRef[]
  messages: Message[]
  verdict: Verdict | null
  usage: { inputTokens, outputTokens, wallClockMs }
  startedAt, completedAt: string              // ISO-8601 UTC
  startedMonotonicNs, completedMonotonicNs: string
}

ArtifactRef { id, kind, path, sha256, bytes, producedByRunKey,
              inputHashes: string[] }

Message { role: "objective" | "finding" | "clarification" | "review",
          from: string, text: string }
```

`scope`, `acceptance`, `artifacts` et `maxDiff` sont absents de `RunInput` : le
runtime les résout et les transmet directement au broker et à l'oracle.

`Message.text` est plafonné à 4 096 octets UTF-8 ; au-delà, un `ArtifactRef`
est obligatoire.

Le jeton porteur d'un bail n'apparaît dans aucun schéma journalisé ; seul son
`sha256` est écrit.

## 11. API d'orchestration

```
runExpert(expertId, taskKind, { objective, inputs, messages }): Promise<RunResult>
parallel(tasks: Array<() => Promise<RunResult>>): Promise<RunResult[]>
pipeline(items, ...stages): Promise<RunResult[]>
```

`runExpert()` : alloue `occurrence` et `invocationPath`, calcule
`observedUpstream`, débite un bail, inscrit le bail au `LeaseRegister`, écrit
`lease_issued`, `dispatch_intent` puis `run_started` sous verrou, invoque `agy`
hors verrou, écrit les événements terminaux sous verrou.

Aucune primitive ne permet de marquer un Run réussi, de fournir un critère, de
révoquer un bail ou d'écrire une attestation.

## 12. Journal et autorité de signature

| Événement | Autorité | Charge utile |
|---|---|---|
| `mission_started` | scheduler | `missionId`, `missionHash`, `missionClass`, `authorityId`, limites, `callSiteTable` |
| `mission_epoch_opened` | scheduler | `epoch`, `ownerId` |
| `lease_issued` | scheduler | `Lease` sans jeton en clair |
| `lease_revoked` | scheduler | `runKey`, `leaseId`, `epoch`, `reason` |
| `dispatch_intent` | scheduler | `runKey`, `leaseId`, `epoch` |
| `run_started` | scheduler | `runKey`, `parentRunKey`, `invocationPath`, `callSiteId`, `occurrence`, `expertId`, `resolved`, `inputDigest`, `startedAt`, `startedMonotonicNs` |
| `artifact_recorded` | broker | `ArtifactRef`, `runKey`, `leaseId`, `epoch` |
| `transaction_staged` | broker | `runKey`, `missionId`, `leaseId`, `epoch`, `transactionId`, `stagedDiffDigest` |
| `transaction_promoted` | broker | `runKey`, `missionId`, `leaseId`, `epoch`, `transactionId`, `stagedDiffDigest`, `commitSha`, `diffDigest` |
| `gate_evaluated` | oracle | `CriterionResult`, `runKey`, `leaseId`, `epoch` |
| `review_attested` | oracle | §7.4, plus `runKey`, `leaseId`, `epoch` |
| `staleness_detected` | oracle | §7.9, plus `runKey`, `leaseId`, `epoch` |
| `run_completed` | oracle | axes de statut, hash de `RunResult`, `completedAt`, `completedMonotonicNs`, `leaseId`, `epoch` |
| `adjudicated` | humain | identité, décision, motif |
| `mission_halted` | scheduler | code de raison |
| `mission_completed` | scheduler | `mission_verdict` |

`run_completed` est écrit par l'oracle seul. La révision 3 l'attribuait au
broker ou à l'oracle, ce qui laissait deux autorités clore un Run.

Tout schéma d'événement de broker et d'oracle porte `epoch` et `leaseId` :
c'est la condition pour que le refus d'époque périmée soit vérifiable
mécaniquement.

### 12.1 Custody de la clé de signature

**Bootstrap.** La paire est générée une fois, à `oma init`, et jamais
régénérée automatiquement. `authorityId = sha256(clé publique)`.

**Stockage.** Clé privée hors workspace : DPAPI portée machine et utilisateur
sous Windows, fichier `0600` détenu par le compte de service ailleurs.
L'implémentation actuelle génère une paire éphémère à chaque démarrage
([`src/ledger/server.ts:102`](../../src/ledger/server.ts)) ; c'est le défaut
que cette section corrige.

**Épingle.** Un fichier d'épingle hors workspace, ACL restreinte —
`%LOCALAPPDATA%\oma\authority\<authorityId>.pin` sous Windows,
`$XDG_STATE_HOME/oma/authority/<authorityId>.pin` ailleurs — contient
`{ authorityId, publicKey, createdAt, lastHead: { seq, hash, sig } }`.
`lastHead` est mis à jour **sous le même verrou exclusif** que la tête du
journal, après `fsync` de l'append. Une tête dont `seq` est inférieur, ou dont
le hash diverge de l'épingle, est un rollback : la mission s'arrête,
`journal_rollback_detected`.

**Identité de service.** `mission_started` enregistre `authorityId`. Une
mission dont la tête est signée par un `authorityId` différent de celui
enregistré s'arrête.

**Rotation.** Commande humaine explicite, jamais automatique. Elle appende
`authority_rotated { oldAuthorityId, newAuthorityId }`, signé par l'ancienne
clé, et crée l'épingle de la nouvelle. Un vérificateur accepte une chaîne
d'`authority_rotated` remontant à l'`authorityId` du `mission_started`.

**Récupération.** Épingle perdue ou illisible : la mission s'arrête,
`signing_pin_lost`. Clé privée perdue : les journaux existants restent
vérifiables par la clé publique de l'épingle, aucune mission ne peut être
reprise sous cette autorité, une rotation manuelle est requise pour repartir.
Aucune dégradation vers un journal non signé, dans aucun cas.

## 13. Catalogue d'experts et registre de politique

### 13.1 Expert

```
id, description: string
tools: { allow: string[], deny: string[] }
modelClass: "fast" | "balanced" | "frontier"
effort: "low" | "medium" | "high"
readOnly: boolean
tasks: { kind, reviews: boolean, scope: string[], artifacts: string[],
         maxDiff: { files, lines },
         acceptance: { id, description, gateId }[] }[]
fixtureCorpusId: string
mutationClasses: string[]
```

`effort` est limité à `low | medium | high` : `xhigh` n'existe pas dans
`agy --help` sur la version installée.

Experts initiaux, aucun autre sans amendement : `oma-orchestrator`,
`oma-planner`, `oma-explorer`, `oma-executor`, `oma-reviewer`, `oma-verifier`.

Classes de mutation initiales, par Expert — §18.6 de la révision 3 est donc
close :

| Expert | `mutationClasses` |
|---|---|
| `oma-planner` | `conclusion_sans_support`, `section_videe`, `troncature_raisonnement` |
| `oma-explorer` | `citation_supprimee`, `plage_decalee`, `symbole_frere` |
| `oma-executor` | `test_non_execute`, `diff_hors_perimetre`, `troncature_raisonnement` |
| `oma-reviewer` | `approbation_sans_critere`, `sujet_partiel`, `citation_supprimee` |
| `oma-verifier` | `preuve_absente`, `plage_decalee`, `conclusion_sans_support` |
| `oma-orchestrator` | sans objet : ne produit aucun artefact jugé |

### 13.2 Registre de politique

```
PolicyRegistry {
  version: string
  classes: { missionClass: string,
             requiredMissionAcceptance: { id, description, gateId }[] }[]
}
```

Ancré dans le bundle du plugin, digest dans `MissionBundle`. Aucune variable
d'environnement ne peut le sélectionner.

Classe initiale obligatoire : `code-change`, portant le critère
`coverage.review-of-every-promotion` défini en §7.5.

### 13.3 Ancrage du registre de gates

Le registre de gates est ancré au même titre : chemin fixe dans le bundle,
digest dans `MissionBundle`. **`OMA_GATES_PATH` est supprimé.** §18.3 de la
révision 3 est close. La conséquence connue — `gate-registry.ts` exige un
`program` absolu existant, ce qui cimente la non-portabilité du bundle — est
une dette de packaging à traiter à la construction, pas une raison de rouvrir
la sélection par environnement.

### 13.4 Contrat de dispatch

```
agy -p <promptEnveloppe> --agent <expertId> --model <resolvedModelId>
    --effort <effort> --output-format stream-json --json-schema <resultSchema>
    --print-timeout <ms>
```

## 14. Interdits explicites

1. Aucune reprise fondée sur une hypothèse quant à l'existence du processus enfant.
2. Aucune réutilisation de bail, aucun redispatch sans révocation préalable.
3. Aucun `--continue` ni reprise de conversation.
4. Aucun `succeeded` sans verdict d'oracle journalisé.
5. Aucun `mission_completed` sans `mission_verdict` couvrant l'union §1.
6. Aucun retranchement humain d'un critère requis par la politique de classe.
7. Aucun contenu d'artefact dans le journal ni dans `Message.text` au-delà de 4 096 octets.
8. Aucun critère ni `gateId` fourni par le script.
9. Aucune attestation de revue écrite ou modifiée par le script.
10. Aucun Expert `readOnly` sans critère `semantic` ou `provenance`.
11. Aucune gate de comptage de classe `semantic`.
12. Aucune gate approuvant un cas muté, ni rejetant un contrôle positif.
13. Aucun corpus de calibration lisible par un Expert ou par le script.
14. Aucun événement, ni aucun effet de broker, portant une époque périmée ou un bail révoqué.
15. Aucun identifiant de modèle hors table de résolution.
16. Aucune écriture agent hors `propose_change`.
16bis. Aucune promotion sans attestation approuvée antérieure, d'un `expertId`
    distinct, quand la politique de classe exige la couverture.
17. Aucun journal non signé, aucune dégradation en cas d'indisponibilité de l'autorité.
18. Aucune sélection du registre de gates ou de politique par variable d'environnement.
19. Aucun champ ajouté aux schémas §10 sans amendement.
20. Aucune revendication de performance sans le protocole §16.

## 15. Critères d'acceptation

Chacun est mécaniquement testable contre le journal, ou contre un refus au
chargement.

**Orchestration**

1. Deux Runs parallèles se chevauchent temporellement, prouvé par des
   intervalles `startedMonotonicNs` et `completedMonotonicNs` sécants, issus du
   même processus scheduler.
2. Un fan-in consomme les artefacts amont, prouvé par `inputHashes`
   correspondant aux `sha256` produits.
3. Une boucle épuisant `maxAttemptsPerPath` s'arrête sans nouveau Run.

**Identité**

4. Deux exécutions du même script avec les mêmes entrées produisent les mêmes
   `runKey`.
5. Deux instances de mission du même bundle ne partagent aucun `runKey`, et une
   réconciliation ne retient un commit que si `oma-mission` et `oma-run`
   correspondent tous deux.
6. Un branchement dont le résultat amont lu diffère produit un `runKey`
   différent, y compris quand ce résultat n'est pas réinjecté dans `inputs`.
7. Deux sites d'appel mutuellement exclusifs au même rang produisent des
   `runKey` différents.
8. Une boucle appelant dix fois le même site produit dix `runKey` distincts, et
   la reprise après crash au cinquième repart à `occurrence = 5` sans
   réattribuer.

**Jugement**

9. Un Run dont l'agent déclare la réussite sans verdict est journalisé
   non-succès.
10. Une opération hors `scope` donne `transaction = rejected` sans exécuter de
    gate.
11. Un diff dépassant `maxDiff` donne `transaction = rejected`.
12. Une gate en échec donne `evaluation = rejected` et ne promeut rien.
13. Un Expert read-only obtient `approved` via gates `artifact` ; un artefact
    vide, ou citant un chemin inexistant, obtient `rejected`.
14. Un catalogue déclarant un Expert `readOnly` sans critère `semantic` ni
    `provenance` est refusé au chargement.
15. Une gate approuvant un cas muté est refusée au chargement.
16. Une gate rejetant tous les contrôles positifs est refusée au chargement.
17. Deux chargements sous graines différentes produisent des corpus de mutation
    différents, et la même gate reste acceptée : la calibration ne dépend pas
    d'un ensemble de hashes fixe.
18. Un artefact dont une entrée a changé est marqué `stale` par
    `staleness_detected` et rend `not_applicable` tout critère qui s'y appuie.

**Couverture**

19. Une mission de classe `code-change` dont le script a omis le reviewer
    échoue sur `coverage.review-of-every-promotion`, sans que l'humain ait eu à
    déclarer ce critère.
20. **Défense en profondeur de l'oracle.** §7.4 fait du runtime le seul auteur
    du manifeste de revue, « complet ou rien » : un manifeste partiel ne peut
    donc pas survenir par le chemin nominal. Le critère éprouve le second
    rempart : soumis directement à l'oracle un manifeste partiel, l'attestation
    produite ne porte pas le `stagedDiffDigest` complet, et la couverture §7.5
    refuse la mission. L'oracle ne fait jamais confiance au runtime pour cette
    propriété.
21. Une revue est attestée avant la promotion de son sujet, et une mission dont
    la revue est attestée après échoue sur `seq(a) < seq(t)`. Ce critère est
    aussi le test que la §7.5 est satisfaisable : il doit exister un chemin
    d'exécution qui la vérifie.
21bis. Une promotion dont le `diffDigest` diffère du `stagedDiffDigest` attesté
    est refusée, `transaction = conflict`, code `staged_promoted_mismatch`.
21ter. **Aucune mutation non revue n'atterrit.** Dans une mission de classe
    `code-change`, une promotion tentée sans attestation approuvée antérieure
    portant son `stagedDiffDigest` est refusée, `transaction = rejected`, code
    `unreviewed_promotion` ; et le dépôt est inchangé après le refus — `HEAD`
    et l'arbre de travail sont identiques à leur état d'avant la tentative.
    La seconde moitié est la partie qui compte : elle distingue « la mission
    échoue » de « rien n'a été muté ».
21quater. Une attestation approuvée dont le `reviewerRunKey` porte le même
    `expertId` que l'auteur de la transaction ne débloque pas la promotion :
    refus `unreviewed_promotion`.
22. Une mission dont le reviewer est le même Expert que l'auteur échoue.
23. Une `missionClass` absente du registre de politique interdit le démarrage.

**Confinement**

24. Un script fournissant `acceptance` ou `gateId` est refusé avant exécution.
25. Un script utilisant `require`, `process`, `constructor`, `__proto__` ou
    `Date.now()` est refusé avant exécution.
26. Le processus script ne peut écrire aucun fichier du worktree, vérifié par
    tentative directe d'écriture, indépendamment du realm JavaScript.
27. Un Expert référençant une entrée absente du manifeste donne `rejected`,
    code `unprovenanced_input`.
28. Un `objective` contredisant le bloc contrat ne modifie pas le périmètre
    appliqué, et le refus est produit par le broker, jamais par le modèle.

**Reprise et fencing**

29. Crash entre `dispatch_intent` et `spawn` : la reprise révoque, ne trouve
    aucun commit, redispatche sous un nouveau bail ; exactement une mutation.
30. Crash après `spawn` sans acquittement, enfant orphelin vivant : la reprise
    révoque ; tout appel broker et tout append de l'orphelin sont refusés
    `capability_revoked` ; le redispatch produit exactement une transaction
    promue.
31. Crash après `spawn`, orphelin ayant déjà promu : la reprise réconcilie par
    `(missionId, runKey)`, ne redispatche pas, et clôt avec
    `reasonCode = reconciled_from_journal`.
32. Crash après commit avant `transaction_promoted` : la reprise émet
    `transaction_promoted` puis `run_completed`, sans invoquer `agy`.
33. Crash après `transaction_promoted` avant `run_completed` : la reprise
    complète depuis le commit.
34. Crash pendant un append : la dernière ligne partielle est tronquée, la
    chaîne reste vérifiable.
35. Un second processus de reprise incrémente l'époque ; les appends **et les
    effets de broker** de l'ancien propriétaire sont refusés.
36. Une promotion en cours ne peut pas chevaucher une bascule d'époque : les
    deux prennent le même verrou et revalident l'époque à l'intérieur.
37. Une reprise dont la résolution de modèle diffère arrête la mission.

**Statuts et journal**

38. Chacune des combinaisons `produced+promoted+rejected`,
    `produced+rejected+approved`, `produced+staged+approved` clos, et
    `outcome_unknown+none+approved` est refusée à l'append.
39. `outcome_unknown+promoted+approved` n'est accepté qu'avec commit et
    `gate_evaluated` complets durables, et
    `reasonCode = reconciled_from_journal`.
40. `mission_completed` est impossible sans `mission_verdict`.
41. Une tête de journal réécrite est détectée par l'épingle hors workspace.
42. Un redémarrage de l'autorité de signature reprend le même `authorityId` et
    accepte de nouvelles preuves.
43. Une rotation d'autorité produit une chaîne vérifiable depuis
    l'`authorityId` du `mission_started` ; une épingle absente arrête la
    mission sans dégrader.

## 16. Protocole de fiabilité longue

Les critères §15 prouvent la correction, pas la fiabilité longue. Celle-ci
exige :

- mission d'au moins 40 Runs, répétée au minimum 10 fois ;
- SLO déclaré avant exécution : taux de missions atteignant
  `mission_verdict approved` sans intervention, taux de mutation dupliquée nul,
  temps de reprise après faute injectée sous seuil — valeurs numériques
  ouvertes, §18 ;
- injection de fautes à chaque frontière : bail, révocation, `dispatch_intent`,
  `spawn`, acquittement, production, promotion, append, mise à jour de tête,
  mise à jour d'épingle, autorité de signature ;
- erreurs de transport transitoires, limitations de débit, épuisement de quota ;
- mesure de croissance du journal, latence de rejeu, rétention d'artefacts ;
- comparaison contrôlée contre Antigravity nu, **avec gel de**
  `resolvedModelId`, effort, prompts, budgets, permissions, commit initial et
  environnement, sur le même jeu de tâches ;
- jeu de tâches adverses ciblant l'analyse superficielle et les fichiers
  pertinents omis, avec tests sémantiques cachés, invisibles du script comme
  des Experts, et disjoints du corpus de calibration §7.3.

La comparaison contrôlée est **essentielle, pas cérémonielle** : rien dans les
§1 à §15 n'établit une qualité de raisonnement supérieure. Ils établissent une
traçabilité et un confinement supérieurs. C'est §16 qui doit trancher le reste,
ou constater que le plan de contrôle ne paie pas.

## 17. Migration et bascule

- `.oma/graph/**` conservé ; une commande de vérification héritée rejoue sa
  chaîne et produit un rapport.
- Aucune mission héritée active n'est migrée : elle est terminée sur le chemin
  hérité ou abandonnée explicitement, jamais transposée.
- Nouveaux espaces versionnés : `.oma/v2/missions/<missionId>/`.
- `src/broker`, `src/oracle` et `src/ledger` conservés ; `src/ledger` fournit la
  signature de tête après correction de la custody §12.1.
- **Déclencheurs de rollback**, tout dépassement ramène au chemin hérité : taux
  de mutation dupliquée non nul, mission impossible à reprendre, autorité de
  signature indisponible plus d'une fois par run long, régression du SLO sous
  la baseline.
- **Condition de bascule** : squelette exécutable passant les 46 critères §15 (43 numérotés plus 21bis, 21ter, 21quater),
  plus une comparaison contrôlée §16 favorable. Jusque-là ADR-001 reste en
  vigueur et le chemin hérité reste exécutable.
- Preuve post-bascule : les 10 missions longues rejouables depuis leur journal.
- Aucune réutilisation de `schemaVersion 2` : `RunInput` porte
  `contractVersion: 1`.

Cette condition de bascule est la différence avec les deux bascules
précédentes, décidées avant toute preuve d'exécution.

## 18. Non décidé

Quatre points restent ouverts. Aucun ne bloque la construction du squelette :
chacun est paramétrable et aucun critère §15 n'en dépend.

1. Table de résolution `modelClass` vers modèles Gemini : noms, ordre de repli,
   politique de quota.
2. Politique de rétention de `.oma/v2/missions/`.
3. Mécanisme d'attente d'une clarification humaine en cours de mission.
4. Valeurs numériques du SLO §16.

Fermés en révision 4 : ancrage du registre de gates et suppression de
`OMA_GATES_PATH` (§13.3), contenu initial du jeu de calibration par Expert
(§13.1).

## 19. Dette déclarée, verdict Codex sur la révision 4

Codex `gpt-5.6-sol` a rejeté la révision 4 (session
`01a05292-8cc7-7480-9f0f-4fbe586a7acd`) avec six blocages. Deux rendaient la
spécification inconstructible et sont corrigés en révision 4.1 : l'attestation
pré-promotion (§7.4, §7.5, §6.2) et l'atomicité journal / registre (§5.2,
§6.4). Les quatre autres sont **assumés comme dette** : la construction du
squelette commence sans eux, et chacun est rattaché au critère §15 qui le
révélera.

### 19.1 Identité d'observation incomplète — critères 6, 8

`observedUpstream` (§3.5) piège la déstructuration, le spread, `JSON.stringify`
et `Reflect.get`. Il ne piège pas `Object.keys`, `Reflect.ownKeys`, `in`,
l'inspection de descripteurs, ni l'identité d'objet. Une capacité du runtime
peut aussi rendre une valeur dérivée sans accès d'accesseur spécifié.

L'allocation d'`occurrence` à la reprise n'a pas de curseur de rejeu : le
document ne distingue pas une allocation rejouée d'une allocation neuve, ni ne
dit comment appels en cache et appels vifs s'entrelacent.

L'ordre préfixe de l'AST n'est déterministe que relativement à une version de
parseur, un dialecte d'AST et un visiteur formellement ordonné, dont aucun
n'est fixé ; l'aliasing et le shadowing des fonctions d'orchestration ne sont
pas couverts.

Position retenue : le critère 6 et le critère 8 sont dans la première tranche
verticale précisément pour forcer ces définitions au contact du code, pas
avant.

### 19.2 Autorité de la classe de mission — critère 23

`missionClass` est **déclarée**, pas dérivée mécaniquement des effets permis ou
observés. Une mission qui écrit du code sous une autre classe enregistrée
échappe au plancher `code-change`. Le digest du registre de politique établit
son immuabilité pendant la mission, pas sa justesse ni son autorisation : rien
n'ancre un plancher de sûreté minimal ni ne lie une classe aux effets.

### 19.3 Frontière de processus surévaluée — critère 26

Le job object Windows limite la création de processus ; il ne restreint ni les
sockets, ni les lectures, ni les écritures hors de l'ACL du worktree
sélectionné. Le disclaimer de §4.2 exclut une évasion de realm *combinée à une
élévation*, alors que la revendication « un unique tube duplex » tombe déjà
avec une évasion de realm seule. Le disclaimer doit être élargi ou la
revendication réduite.

### 19.4 Calibration et rollback co-gouvernés — critères 15, 17, 41

Une gate peut sur-apprendre la grammaire de transformation du mutateur au lieu
des hashes de fixtures. « Prédicat sémantique plutôt qu'identitaire » n'est pas
mécaniquement vérifiable sur un exécutable arbitraire. Les noms de classes de
mutation de §13.1 n'ont ni transformation normative ni algorithme d'étiquette
attendue. Aucune indépendance n'est exigée entre auteur de gate, auteur du
mutateur et curateur du corpus.

L'épingle ne protège du rollback que tant que l'attaquant ne peut pas l'écrire
aussi : qui écrit journal **et** épingle peut restaurer un couple signé plus
ancien sans connaître la clé privée.

### 19.5 Limites de la couverture, admises

Recensées en §7.5 : la livraison n'est pas la lecture, `expertId` distinct
n'est pas une indépendance de modèle ou d'opérateur, et un changement éclaté en
transactions individuellement anodines n'est jamais revu dans son effet
combiné.

### 19.6 Critères encore sous-définis

Codex en compte treize : 1, 3, 4, 6, 8, 10, 11, 15, 17, 18, 20, 25, 29. Deux
sont des contradictions à trancher immédiatement à l'implémentation :

- **3** — comment une boucle épuise-t-elle `maxAttemptsPerPath` si chaque
  `occurrence` crée un `invocationPath` différent ? La limite doit porter sur le
  couple `(parentInvocationPath, callSiteId)`, pas sur le chemin complet.
- **25** — §4.2 fait lever `Date.now()` à l'exécution, alors que le critère
  exige un refus **avant** exécution. Le refus statique prime ; la levée reste
  la défense en profondeur.

Les onze autres sont des précisions à écrire avec le test qui les consomme,
pas avant.

### 19.7 Ordre de construction retenu

Ordre de la première tranche verticale, tel que proposé par Codex, chaque item
choisi pour tuer un risque de conception au plus tôt :

| Rang | Critère | Ce qu'il tue |
|---|---|---|
| 1 | 21 et 21bis | La revue pré-promotion est-elle réellement satisfaisable. |
| 2 | 20 | Octets du diff injecté, construction du sujet, sujets éclatés. |
| 3 | 30 | Autorité de bail, fencing au site de l'effet, redispatch, ensemble. |
| 4 | 32 | La fenêtre d'atomicité Git / journal la plus dangereuse. |
| 5 | 35 | Un propriétaire périmé perd l'append **et** la mutation. |
| 6 | 6 | La nouvelle dépendance de correction, avant que le cache s'appuie dessus. |
| 7 | 8 | Force la sémantique rejeu / vif à devenir non ambiguë. |
| 8 | 41 | Frontière réelle de protection de l'épingle et de la custody. |

### 19.8 État de la construction

**Rangs 1 et 2 construits et vérifiés, 30 août 2026.** Critères 19, 20, 21 et
21bis passent sur de vraies transactions Git. `npm run build` exit 0 ;
`npm test` : 74 tests, 73 pass, 0 fail, 1 skip préexistant (création de symlink
refusée par Windows, `EPERM`). Suite exécutée localement, jamais en sandbox.

Substrat livré : `src/broker/{staging,promotion,staged-review}.ts`,
`src/ledger/mission-journal.ts`, `src/oracle/{review,coverage}.ts`,
`src/policy/registry.ts`, `src/runtime/review.ts`,
`src/orchestration/model.ts` et sa suite de tests. `src/graph/` non touché.

**Rien de la révision 4.1 ne s'est révélé impossible à l'implémentation.** Quatre
ambiguïtés ont exigé une convention ; elles sont désormais normatives et non
plus laissées à l'implémenteur : octets du diff canonique (§6.2), sérialisation
de `subjectDigest` (§7.4), rapport entre `reviewerRunKey` et `runKey` (§7.4),
statut du critère 20 comme défense en profondeur de l'oracle (§15).

Le journal de cette tranche est append-only et in-process. Signature,
persistance durable et custody restent hors périmètre : rangs 3 à 8.
