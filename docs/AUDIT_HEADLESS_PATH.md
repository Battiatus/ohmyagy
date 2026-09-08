# Audit — Le chemin d'exécution headless détaché (« processus fantôme »)

**But** : décider du sort du chemin détaché que la vision interdit, en connaissance de cause.
**Statut** : audit factuel, aucune modification de ce chemin effectuée.

---

## 1. La chaîne complète, du clic utilisateur au démon

```
/oma:run <objective>                        .agents/plugins/oma/commands/run.md
   │  (commande → instruit le LLM d'appeler l'outil MCP)
   ▼
MCP tool "run_mission" {goal}               src/mcp/broker-server.ts:330  executeMission()
   ▼
launchDetachedCli(...)                       src/mcp/broker-server.ts:347
   │  spawn(node, [bin/oma.js, "run", missionId, "--goal", goal],
   │        { detached: true, stdio: [ignore, log, log] }).unref()
   ▼   ── PROCESSUS DÉTACHÉ, HORS SESSION ──
bin/oma.ts → runOmaCli(["run", …])           src/cli/oma-cli.ts:232
   ▼
RealMissionExecutor.execute({...})           src/orchestration/real-mission.ts:88
   │  Orchestration par vagues : planner → workers → reviewers → gates → promotion
   ▼
AgyDriver.invoke({...}) par agent            src/runtime/agy-driver.ts:81
   │  spawn "agy"/"gemini" CLI  --model <slug> --agent <persona> -p <prompt>
   ▼
Écrit .oma/missions/<id>/… + ledger events.jsonl
```

La session, elle, ne fait ensuite que **sonder** l'état :
`/oma:status` → `mission_status`, `/oma:list` → `list_missions`, `/oma:inspect` → `mission_inspect`
(tous en lecture seule via `src/mission/read-model.ts`).

## 2. Pourquoi ça contredit la vision

1. **Hors-session** : `spawn(..., {detached:true}).unref()` = démon d'arrière-plan. La spec le classe **Out of Scope** (« Moteur démon autonome hors session »).
2. **Aucun contexte conversationnel** : l'outil ne transmet **qu'une string `goal`**. Le démon ne voit ni l'historique, ni le projet, ni le brain.
3. **Aucun alignement interactif** : `/oma:run` déclenche `run_mission` immédiatement — pas de décorticage, pas de question à l'utilisateur.
4. **Continuité par sondage, pas par intégration** : la session observe un processus étranger au lieu de piloter les nœuds elle-même.

## 3. Ce qui dépend de ce chemin (impact d'un retrait)

| Dépendance | Fichier | Impact si retiré |
|---|---|---|
| Test « run_mission returns a watchable mission id » | `src/mcp/__tests__/broker-server.test.ts:163` | à migrer/retirer |
| Suite orchestration réelle | `src/orchestration/__tests__/real-mission.test.ts` | reste valable pour le moteur, mais plus exposé |
| Suite E2E réelle | `src/orchestration/__tests__/real-mission.e2e.test.ts` | idem |
| Commandes `/oma:run`, `/oma:resume` | `commands/run.md`, `commands/resume.md` | à repointer |
| Read-model status/list/inspect + skills `oma-watch`, `graph-recovery` | `src/mission/read-model.ts`, skills | supposent des dossiers de mission produits par le démon |
| CLI `oma run` / `oma resume` / `oma watch` | `src/cli/oma-cli.ts:232,286,36` | inchangés (CLI directe hors plugin) |

**Note importante** : `RealMissionExecutor` et `AgyDriver` ne sont **pas à jeter** — le moteur par vagues, la résolution de capacités (`fast=gemini-2.5-flash`, `balanced`, `frontier`) et l'invocation `agy`/`gemini` sont **réutilisés** par le flow session-native (dispatch des sous-agents) et par le futur hook résumeur Flash. Ce qui pose problème, c'est **le lancement détaché** (`launchDetachedCli`) et le fait que ce soit le **défaut** — pas le moteur lui-même.

## 4. Les deux options pour ta décision

### Option A — Garder en « legacy detached » explicite (non-défaut)
- `run_mission`/`resume_mission` restent, mais **ne sont plus le point d'entrée par défaut**. La skill `oma-start` (conductor) devient le défaut ; `/oma:run` est repointé ou un `/oma:start` natif est ajouté.
- Le mode détaché reste accessible pour les cas « fire-and-forget » longue durée explicitement demandés.
- **Risque : faible.** Aucun test cassé. Cohérent avec ce que la skill fait déjà (section « Legacy Detached Mode »).

### Option B — Retirer du plugin shippé
- `run_mission`/`resume_mission` retirés des outils MCP et des commandes ; `launchDetachedCli` supprimé. Le code `RealMissionExecutor` reste dans `src/` (CLI directe + réutilisé in-session).
- **Risque : moyen.** 3 fichiers de test à migrer (broker-server, real-mission, real-mission.e2e), commandes à réécrire, read-model à réorienter vers l'état produit in-session.
- **Plus fidèle** à « aucun processus fantôme ».

### Recommandation
**Option A d'abord** (rebrancher le défaut vers le session-native, garder le détaché en legacy non-exposé par défaut), puis migrer vers B une fois le flow session-native éprouvé end-to-end. On supprime le risque de régression tout en rendant la vision vraie immédiatement.

## 5. Indépendant de cette décision (en cours d'implémentation)

Ces deux pièces ne touchent PAS le chemin headless et sont construites maintenant :
1. **Rebranchement de l'entrée** : commande `/oma:start` → skill conductrice `oma-start` in-session.
2. **Hook résumeur Flash** : hook `Stop` → `AgyDriver.invoke({modelTier:"fast"})` reformule l'échange → `BrainStore`.
