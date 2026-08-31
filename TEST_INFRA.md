# E2E Test Infra: Oh My Antigravity (OMA)

## Test Philosophy
- Opaque-box, requirement-driven, deterministic test suite.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial + Fault Injection & Crash Scenarios.

## Feature Inventory & Test Mapping
| # | Feature | Requirement Source | Tier 1 (Unit/Feature) | Tier 2 (Boundary/Edge) | Tier 3 (Cross-Feature) | Tier 4 (Integration/E2E) |
|---|---------|-------------------|:---------------------:|:----------------------:|:----------------------:|:------------------------:|
| 1 | GraphProposal & Validation | WP-2 / Spec | 5 | 5 | ✓ | ✓ |
| 2 | Kahn Sort & Cycle Diagnostics | WP-2 / Spec | 5 | 5 | ✓ | ✓ |
| 3 | Terminal Node Reactivation Guard | WP-2 / Spec | 5 | 5 | ✓ | ✓ |
| 4 | Atomic CAS & SHA-256 Ledger | WP-2 / Spec | 5 | 5 | ✓ | ✓ |
| 5 | Antigravity Headless Driver | WP-3 / Spec | 5 | 5 | ✓ | ✓ |
| 6 | Win32 Job Object Confinement | WP-3 / Spec | 5 | 5 | ✓ | ✓ |
| 7 | Hermetic Mock Adapter | WP-3 / Spec | 5 | 5 | ✓ | ✓ |
| 8 | Secret Scrubber | WP-3 / Spec | 5 | 5 | ✓ | ✓ |
| 9 | Parallel Task Scheduler | WP-4 / Spec | 5 | 5 | ✓ | ✓ |
| 10 | Git Worktree Isolation | WP-4 / Spec | 5 | 5 | ✓ | ✓ |
| 11 | Crash Recovery (oma resume) | WP-4 / Spec | 5 | 5 | ✓ | ✓ |
| 12 | Epoch Fencing & Zombie Purge | WP-4 / Spec | 5 | 5 | ✓ | ✓ |
| 13 | MCP 2PC Review Enforcement | WP-5 / Spec | 5 | 5 | ✓ | ✓ |
| 14 | Dual Persona Enforcement | WP-5 / Spec | 5 | 5 | ✓ | ✓ |
| 15 | Staging Oracle Quality Gates | WP-5 / Spec | 5 | 5 | ✓ | ✓ |
| 16 | Durable MissionJournal | WP-5 / Spec | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test Runner: Node.js test runner (`node --test`) and Bun test (`bun test`).
- Test Directory Structure:
  - Unit tests: `src/**/__tests__/*.test.ts`
  - Integration/E2E tests: `tests/e2e/*.test.ts`
- Pass/Fail Semantics: 0 exit code on 100% passed tests, 0 warnings / unhandled rejections.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Expected Outcome |
|---|----------|--------------------|------------------|
| 1 | Dynamic Graph Expansion & Forking | F1, F2, F4, F9, F10 | Dynamic fork of subtasks executes cleanly in parallel worktrees |
| 2 | Hard Crash & Exact Deterministic Resume | F4, F11, F12, F10 | Crash simulation mid-flight resumes incomplete nodes without duplicate work |
| 3 | Malicious / Self-Approval Review Bypass Attempt | F13, F14, F15 | Attempting to promote staged changes without independent attestation fails |
| 4 | Fork Bomb & Child Process Leak Defense | F5, F6, F7 | Master crash terminates all sub-processes instantly via Job Object |
| 5 | End-to-End Multi-Agent Mission Pipeline | F1..F16 | Complete autonomous mission with planning, coding, review, and publication |
