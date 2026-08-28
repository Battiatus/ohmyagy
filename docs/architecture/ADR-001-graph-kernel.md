# ADR-001 : Graph Kernel acyclique comme control plane OMA

## Statut

Accepté le 28 août 2026 à la demande explicite de l'utilisateur.

## Contexte

OMA ne doit pas reposer sur une boucle autonome qui demande au même LLM de
continuer, se corriger et déclarer sa réussite. Les modèles changent de
personnalité, de stratégie et de niveau d'effort entre deux invocations. Ils ne
peuvent donc pas être l'autorité du workflow.

Le spike précédent possédait un tableau de tâches avec dépendances, mais son
contrôleur sélectionnait un seul prochain élément. Il s'agissait d'un pipeline
de checks, pas d'un moteur de graphe.

## Options considérées

| Option | Avantages | Inconvénients | Décision |
|---|---|---|---|
| Boucle autonome avec TODO enforcer | Simple, familière | Le LLM contrôle la continuation et peut dériver | Rejetée |
| Pipeline fixe avec verify/fix | Facile à observer | Fan-out, branches et reprise restent implicites | Rejetée |
| DAG événementiel typé | Dépendances, branches, fan-out/fan-in et replay explicites | Plus de schéma et d'événements | Retenue |
| Graphe cyclique généraliste | Modélise les retries | Réintroduit les loops sous forme d'arêtes | Rejetée |

## Décision

Le control plane autoritatif est un DAG versionné :

- les cycles et self-loops sont refusés au parsing ;
- chaque nœud est dispatché au plus une fois par révision ;
- tous les nœuds prêts sont retournés comme un `readySet`, sans choix LLM ;
- `activation: all` fournit le fan-in strict ;
- `activation: any` fournit les merges conditionnels ;
- les arêtes portent `success`, `failure` ou `always` ;
- un échec suit une arête explicite vers un autre nœud ou une décision humaine ;
- aucun retry implicite n'existe dans la même révision ;
- l'état est une projection déterministe du graphe et du journal d'événements ;
- le broker termine les nœuds agent, l'oracle termine les gates, le scheduler
  termine les joins et l'humain termine les décisions humaines ;
- l'ordre de déclaration JSON n'affecte pas la projection.

Chaque invocation LLM est bornée à un nœud et ne peut modifier ni le graphe ni
le journal. Le broker transactionnel, les worktrees, les gates et le ledger
signé restent des exécutants sous le Graph Kernel.

## Conséquences

Positives : reprise reconstructible, parallélisme explicite, modèles
remplaçables, branches d'échec auditées et absence de boucle cachée.

Négatives : un nouveau travail après échec nécessite une nouvelle branche déjà
déclarée ou une nouvelle révision du graphe autorisée. C'est volontaire : OMA
préfère arrêter le graphe plutôt que permettre au modèle d'inventer une boucle.

## Limite et prochaine autorité

Le journal local est hashé et protégé par le hook Antigravity, mais son identité
d'autorité n'est pas encore une signature cryptographique par événement. La
prochaine révision doit relier ces transitions à l'autorité Ed25519 déjà
implémentée, sans modifier les règles du DAG.
