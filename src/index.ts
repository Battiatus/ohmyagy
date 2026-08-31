import { runGraphCli } from "./graph/cli.js";
import { runOmaCli } from "./cli/oma-cli.js";

export async function init(args = process.argv.slice(2)): Promise<number> {
  if (args[0] === "graph") {
    return runGraphCli(args.slice(1));
  }
  if (args[0] === "mcp" && args[1] === "serve") {
    await import("./mcp/broker-server.js");
    return 0;
  }
  return runOmaCli(args);
}

export * from "./graph/model.js";
export * from "./graph/kernel.js";
export * from "./graph/store.js";
export * from "./graph/proposal.js";
export * from "./graph/broker.js";
export * from "./graph/mission-projections.js";
export * from "./runtime/process-runner.js";
export * from "./runtime/secret-scrubber.js";
export * from "./runtime/agy-driver.js";
export * from "./runtime/mock-driver.js";
export * from "./runtime/capability-resolver.js";
export * from "./runtime/doctor.js";
export * from "./oracle/objective-judge.js";
export * from "./oracle/adversarial-review.js";
export * from "./ledger/mission-events.js";
export * from "./orchestration/integrator.js";
export * from "./orchestration/wave-scheduler.js";
export * from "./orchestration/worktree-pool.js";
export * from "./orchestration/scheduler.js";
export * from "./orchestration/resume.js";
export * from "./resume/engine.js";
export * from "./benchmark/types.js";
export * from "./cli/oma-cli.js";
export * from "./packaging/install.js";
