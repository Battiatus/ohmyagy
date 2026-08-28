# Architecture Analysis of OhMyOpenCode/OhMyOpenAgent

> **Document historique, non normatif.** Cette première exploration est remplacée par [l'architecture cible](docs/TARGET_ARCHITECTURE.md), fondée sur une rétro-ingénierie sourcée des quatre projets et des surfaces Antigravity officielles.

This document maps the architectural patterns and implementations extracted from the oh-my-claudecode and oh-my-openagent repositories.

## 1. IntentGate Implementation
Unlike traditional command-line interfaces that use regex parsers to intercept input, the **IntentGate** is implemented as a strict prompt engineering constraint (a system prompt override).
*   **Location**: oh-my-openagent/packages/omo-opencode/src/agents/sisyphus/gemini.ts (inside uildGeminiIntentGateEnforcement()).
*   **Mechanism**: It forces the LLM to classify the user's intent before executing any tool or writing any code. The LLM must output a specific format:
    `
    I detect [TYPE] intent - [REASON].
    My approach: [ROUTING DECISION].
    `
*   This acts as a "gate" preventing the AI from jumping straight into implementation when the user just wanted research or explanation.

## 2. "Team Mode" and Multiplexing
Parallel execution and subagent orchestration (Team Mode) rely heavily on **tmux** rather than native Node.js child processes directly communicating via stdout/stdin.
*   **Location**: oh-my-opencode/src/features/tmux-subagent/manager.ts and oh-my-claudecode/src/team/tmux-session.ts.
*   **Mechanism**: The system uses spawnTmuxPane() to create isolated tmux panes for each subagent. This allows parallel execution while keeping the environment separated and allowing developers to physically attach to the tmux session to see what the agents are doing in real-time.

## 3. State Persistence
The system persists complex workflow states to the local filesystem using specific dot-folders.
*   **Oh-My-OpenAgent (ultrawork)**: Uses the .omo/plans/ directory to store Markdown-based execution plans (.omo/plans/<slug>.md). This serves as the durable memory for the ulw-plan and ulw-execute workflows.
*   **Oh-My-ClaudeCode (ultragoal)**: Uses the .omc/ultragoal/ directory to track complex multi-goal tasks. It persists state in structured files such as rief.md (the goal description), goals.json (the tasks), and ledger.jsonl (the execution log).
*   **Mechanism**: Code references like oh-my-claudecode/src/ultragoal/artifacts.ts show functions to read, write, and checkpoint these files. By storing state in the filesystem, the agents can survive context window exhaustion or session restarts.

## 4. Verification Loop
The verification loop is deeply integrated into the agent's workflow, enforcing correctness before a task can be marked as complete.
*   **LSP Diagnostics**: The agents have access to lsp_diagnostics (single file) and lsp_diagnostics_directory (project-wide) tools. These are implemented in oh-my-claudecode/src/tools/diagnostics/tsc-runner.ts and lsp-aggregator.ts.
*   **Evidence Requirements**: The verification is strictly gated. In oh-my-claudecode/src/verification/tier-selector.ts, there are explicit evidenceRequired arrays (e.g., ['lsp_diagnostics clean', 'build pass']) that must be satisfied.
*   **Pre-Tool-Use Hooks**: The system uses hooks like oh-my-claudecode/templates/hooks/pre-tool-use.mjs to intercept bash commands. If an agent tries to modify a source file directly via bash (e.g., using sed or echo >), the hook warns the agent to use the proper executor tools instead, enforcing discipline.
