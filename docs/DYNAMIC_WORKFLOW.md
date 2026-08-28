# Dynamic Workflow OMA

## Statut

Décision préparatoire acceptée le 28 août 2026. Ce document est le point de
reprise obligatoire de la prochaine session. Il complète ADR-001 sans modifier
son invariant principal : OMA reste exclusivement fondé sur un DAG, sans loop
engineering.

## Objectif

Faire évoluer OMA d'un DAG entièrement prédéfini vers un moteur de workflow
dynamique contrôlé. Le travail peut être découvert pendant la mission, mais le
LLM ne devient jamais l'autorité du workflow.

Principe : **planification dynamique, exécution déterministe, mutation du
graphe sous autorité externe**.

## Modèle

```text
Mission
  -> analyse bornée
  -> GraphProposal
  -> validation par Graph Broker
  -> DAG signé, révision N
  -> dispatch unique des nœuds ready
  -> broker/oracle/humain produit les verdicts
  -> terminaison ou GraphProposal pour la révision N+1
```

Une nouvelle information ou un échec ne réactive jamais un ancien nœud. Elle
peut produire une nouvelle révision contenant de nouveaux nœuds et de nouvelles
preuves.

## Invariants non négociables

1. Chaque révision est un DAG ; cycles et self-loops sont refusés.
2. Un nœud est dispatché au plus une fois par révision.
3. Aucun retry, continuation de conversation ou `verify/fix until done` implicite.
4. Le LLM peut proposer un graphe mais ne peut ni le publier ni modifier le
   journal d'événements.
5. Le scheduler n'exécute que le `readySet` d'une révision autorisée.
6. Chaque nœud agent correspond à une invocation `agy -p` indépendante et
   bornée.
7. Les succès sont décidés par le broker, les gates par l'oracle, les joins par
   le scheduler et les décisions métier par un humain nommé.
8. Toute extension doit déclarer budget, dépendances, ressources, autorité de
   complétion, critères d'acceptation et branches d'échec.
9. Une révision ne peut supprimer ni réécrire l'historique autoritatif précédent.
10. En cas d'ambiguïté, conflit ou budget épuisé, le graphe s'arrête.

## GraphProposal

Une proposition doit contenir au minimum :

- identifiant et hash de la révision parent ;
- motif et preuves ayant déclenché l'extension ;
- nœuds et arêtes ajoutés ;
- budgets temps, tokens, appels et fan-out ;
- capacités, outils et modèles requis ;
- périmètres de fichiers et conflits attendus ;
- critères d'acceptation observables ;
- autorités de complétion ;
- branches `success`, `failure` ou `always` ;
- identité du proposant.

## Graph Broker

Le Graph Broker est un processus séparé du LLM. Avant publication d'une
révision, il vérifie :

- schéma strict et absence de champs cachés ;
- acyclicité et références valides ;
- absence de retry déguisé ou de retour sémantique vers un ancien nœud ;
- croissance du graphe et budgets autorisés ;
- conflits de ressources et de fichiers ;
- disponibilité des capacités demandées ;
- présence de gates et de chemins d'échec ;
- cohérence avec la mission et les preuves parentes ;
- CAS sur la révision et le head du journal.

Une proposition acceptée produit une révision immuable et signée. Une
proposition rejetée ne modifie aucun état autoritatif.

## Ordre de réalisation à la prochaine session

1. Relire ADR-001, ce document et l'état `oma graph status`.
2. Écrire le schéma et les tests adversariaux de `GraphProposal`.
3. Implémenter la validation pure du delta de graphe.
4. Implémenter le Graph Broker avec CAS et publication atomique de la révision.
5. Relier les signatures Ed25519 existantes aux transitions et révisions.
6. Ajouter un driver qui lance exactement une invocation Antigravity par nœud.
7. Relier les reçus broker/oracle aux événements de complétion.
8. Construire la tranche verticale : fan-out, interruption, reprise, gate,
   extension dynamique, terminaison.
9. Seulement après cette tranche, construire le benchmark OMA contre
   Antigravity sans OMA.

## Critères d'acceptation de la tranche verticale

- une mission inconnue à l'avance peut produire une extension validée ;
- une tentative cyclique, un retry déguisé et une mutation LLM sont rejetés ;
- une interruption reconstruira le même graphe et le même `readySet` ;
- deux propositions concurrentes ne peuvent publier la même révision parent ;
- un nœud ne déclenche jamais plus d'une invocation ;
- une gate en échec ne promeut aucun changement ;
- l'historique et les signatures permettent d'expliquer chaque transition ;
- aucun mécanisme de loop engineering n'est présent dans le code ou les prompts.

## Non-objectifs initiaux

- base de données graphe externe ;
- replanification libre par le LLM ;
- reprise de conversation comme mécanisme d'exécution ;
- retries automatiques ;
- optimisation prématurée du routage multi-modèle ;
- comparaison publique de performance avant une tranche end-to-end vérifiée.
