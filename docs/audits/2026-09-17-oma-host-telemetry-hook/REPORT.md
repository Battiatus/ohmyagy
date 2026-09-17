# Audit 2026-09-17 — « rien ne se produit » : troisième cause, prouvée à l'exécution

Complément des audits `2026-09-16-oma-session-identity` (canal d'identité de projet)
et `2026-09-17-oma-empty-envelope` (enveloppe de succès vide + `--new-project`).

## La cause la plus visible, trouvée aujourd'hui

Le plugin **Google** `googlecloudtools.datacloud_telemetry` (installé globalement,
hors OMA) enregistre un hook `PreToolUse` matcher `*` dont la commande Windows
contient des guillemets imbriqués :

```
node "C:\...\telemetry_hook_bundle.js" --agent_name gemini --install_source "Antigravity IDE" ; exit 0
```

Sous Windows, le lanceur reçoit le chemin concaténé avec des guillemets littéraux :

```
Error: Cannot find module 'C:\...\datacloud_telemetry\"C:\...\telemetry_hook_bundle.js"'
```

Le hook échoue en `exit 1` **sur chaque appel d'outil**, dans **toutes** les sessions
Antigravity (IDE 2.0 et CLI), et le harnais avorte l'outillage avant exécution.

Symptôme utilisateur correspondant exactement : `agy -p` rend une enveloppe
`SUCCESS` **non vide** (le modèle parle), mais aucun outil ne s'exécute — pas
d'édition, pas de commande. « Rien ne se produit » tout en ayant l'air de réussir.
Dans OMA : le planner (sans outil) réussit, l'executor et le fixer répondent
poliment qu'ils sont bloqués, la mission finit `budget_exhausted` avec 0 diff.

## Preuve de bout en bout (machine réelle)

| Étape | Résultat |
|---|---|
| Avant désactivation : mission manuelle `manual-e2e-probe` | `budget_exhausted`, 0 diff, executor et fixer bloqués par le MODULE_NOT_FOUND du hook |
| `agy plugin disable googlecloudtools.datacloud_telemetry` | `config.json: enabled=false` |
| Après désactivation : même mission | **SUCCEEDED** — planner → executor (worktree isolé) → reviewer-alpha + reviewer-beta APPROVED → 2 gates PASSED → intégration commit `512bac08`, `value.txt = "after"` |
| `OMA_REAL_AGY=1 bun test agy-driver.real.test.ts` | 1 pass (27 s) |
| `OMA_REAL_AGY=1 bun test real-mission.e2e.test.ts` | 1 pass — état terminal fidèlement reflété via la vraie palette MCP stdio |
| Suite complète `bun test` | 469 pass, 0 fail, 3 skip (les tests réels, volontairement opt-in) |

## Côté hôte, corrélé aux correctifs code

- `--new-project` vérifié dans les logs AGY : chaque run OMA reçoit un projet frais
  (`project: created project "oma-e2e-real-..."`) au lieu de `default-cli-project`.
- Le mécanisme de détection d'enveloppe vide (`isEmptyAgySuccessEnvelope`) reste
  nécessaire : c'est l'autre cause, mesurée le matin même (print-timeout avec tour
  d'outil en cours), et elle resterait silencieuse sans lui.
- `oma doctor` atteste désormais `--new-project` dans les flags supportés et liste
  l'historique des tentatives de bind (`bindHistory`) pour la question racine du
  projet gouverné.

## Action produite hors dépôt

Le plugin `googlecloudtools.datacloud_telemetry` a été **désactivé** sur cette
machine (`agy plugin disable`). C'est un plugin de télémétrie Google : le désactiver
ne retire aucune capacité d'agent. Si Google le réinstalle/à jour, vérifier le
format de la commande du hook avant de la réactiver.

## Point d'architecture encore ouvert (déjà documenté)

Résolution de l'identité du projet pour le serveur MCP en session IDE :
verdict de sonde `hook-channel-only` (voir audit 2026-09-16). Le hook reçoit
`workspacePaths`, le serveur MCP ne reçoit rien ; le multiplexage par session reste
à construire. Les `bindAttempts` de `doctor` sont le mensonge-témoin en attendant.
