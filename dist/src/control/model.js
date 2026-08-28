export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(record, key) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Expected non-empty string at ${key}`);
    }
    return value;
}
function requireStringArray(record, key) {
    const value = record[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`Expected string array at ${key}`);
    }
    return value;
}
export function parseMissionContract(value) {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error("Unsupported mission contract schema");
    }
    const status = requireString(value, "status");
    if (!["draft", "ready", "blocked", "done"].includes(status)) {
        throw new Error(`Invalid mission status: ${status}`);
    }
    const executionGate = requireString(value, "executionGate");
    if (executionGate !== "allowed" && executionGate !== "blocked") {
        throw new Error(`Invalid execution gate: ${executionGate}`);
    }
    const rawCriteria = value.acceptanceCriteria;
    if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
        throw new Error("Mission requires acceptance criteria");
    }
    const acceptanceCriteria = rawCriteria.map((criterion, index) => {
        if (!isRecord(criterion)) {
            throw new Error(`Invalid acceptance criterion at index ${index}`);
        }
        return {
            id: requireString(criterion, "id"),
            description: requireString(criterion, "description"),
        };
    });
    const maxIterationRounds = value.maxIterationRounds;
    if (!Number.isInteger(maxIterationRounds) || Number(maxIterationRounds) < 1) {
        throw new Error("maxIterationRounds must be a positive integer");
    }
    return {
        schemaVersion: 1,
        missionId: requireString(value, "missionId"),
        status: status,
        executionGate,
        problem: requireString(value, "problem"),
        goal: requireString(value, "goal"),
        scope: requireStringArray(value, "scope"),
        nonGoals: requireStringArray(value, "nonGoals"),
        acceptanceCriteria,
        dependencies: requireStringArray(value, "dependencies"),
        targetEnvironment: requireString(value, "targetEnvironment"),
        maxIterationRounds: Number(maxIterationRounds),
        authorizedBy: requireString(value, "authorizedBy"),
    };
}
function parseCheck(value, taskId, index) {
    if (!isRecord(value)) {
        throw new Error(`Invalid check ${taskId}[${index}]`);
    }
    return {
        id: requireString(value, "id"),
        program: requireString(value, "program"),
        args: requireStringArray(value, "args"),
        cwd: requireString(value, "cwd"),
        trackedPaths: requireStringArray(value, "trackedPaths"),
    };
}
export function parseTaskGraph(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks)) {
        throw new Error("Unsupported task graph schema");
    }
    const tasks = value.tasks.map((task, index) => {
        if (!isRecord(task)) {
            throw new Error(`Invalid task at index ${index}`);
        }
        const id = requireString(task, "id");
        if (!Array.isArray(task.acceptanceChecks)) {
            throw new Error(`Task ${id} requires acceptanceChecks`);
        }
        return {
            id,
            title: requireString(task, "title"),
            dependencies: requireStringArray(task, "dependencies"),
            scope: requireStringArray(task, "scope"),
            acceptanceChecks: task.acceptanceChecks.map((check, checkIndex) => parseCheck(check, id, checkIndex)),
        };
    });
    const ids = new Set();
    for (const task of tasks) {
        if (ids.has(task.id)) {
            throw new Error(`Duplicate task id: ${task.id}`);
        }
        ids.add(task.id);
    }
    for (const task of tasks) {
        for (const dependency of task.dependencies) {
            if (!ids.has(dependency)) {
                throw new Error(`Unknown dependency ${dependency} for ${task.id}`);
            }
        }
    }
    assertAcyclic(tasks);
    return {
        schemaVersion: 1,
        missionId: requireString(value, "missionId"),
        tasks,
    };
}
function assertAcyclic(tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
        if (visiting.has(id)) {
            throw new Error(`Task graph cycle detected at ${id}`);
        }
        if (visited.has(id)) {
            return;
        }
        visiting.add(id);
        const task = byId.get(id);
        if (!task) {
            throw new Error(`Missing task ${id}`);
        }
        for (const dependency of task.dependencies) {
            visit(dependency);
        }
        visiting.delete(id);
        visited.add(id);
    };
    for (const task of tasks) {
        visit(task.id);
    }
}
export function parseCommandEvidence(value) {
    if (!isRecord(value) || value.eventType !== "check_run") {
        throw new Error("Invalid ledger event");
    }
    const command = value.command;
    const result = value.result;
    if (!isRecord(command) || !isRecord(result)) {
        throw new Error("Invalid ledger command or result");
    }
    const sequence = value.sequence;
    const exitCode = result.exitCode;
    if (!Number.isInteger(sequence) || !Number.isInteger(exitCode)) {
        throw new Error("Ledger sequence and exitCode must be integers");
    }
    if (typeof value.stableInputs !== "boolean") {
        throw new Error("Ledger stableInputs must be boolean");
    }
    return {
        sequence: Number(sequence),
        timestamp: requireString(value, "timestamp"),
        eventType: "check_run",
        taskId: requireString(value, "taskId"),
        checkId: requireString(value, "checkId"),
        contractHash: requireString(value, "contractHash"),
        graphHash: requireString(value, "graphHash"),
        inputHashBefore: requireString(value, "inputHashBefore"),
        inputHashAfter: requireString(value, "inputHashAfter"),
        stableInputs: value.stableInputs,
        command: {
            program: requireString(command, "program"),
            args: requireStringArray(command, "args"),
            cwd: requireString(command, "cwd"),
        },
        result: {
            exitCode: Number(exitCode),
            stdoutHash: requireString(result, "stdoutHash"),
            stderrHash: requireString(result, "stderrHash"),
        },
        previousHash: requireString(value, "previousHash"),
        entryHash: requireString(value, "entryHash"),
    };
}
