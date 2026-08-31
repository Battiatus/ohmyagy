export function parseExpression(input) {
    const trimmed = input.trim();
    if (trimmed.startsWith("fib(")) {
        const end = trimmed.lastIndexOf(")");
        if (end === -1)
            throw new Error("Invalid fib expression syntax");
        const num = parseInt(trimmed.substring(4, end).trim(), 10);
        if (isNaN(num))
            throw new Error("Invalid number in fib expression");
        return { op: "fib", args: [num] };
    }
    // Handle binary operations: add and multiply
    if (trimmed.includes("+")) {
        const parts = trimmed.split("+").map((s) => s.trim());
        if (parts.length !== 2)
            throw new Error("Only binary add supported");
        const a = parseFloat(parts[0]);
        const b = parseFloat(parts[1]);
        if (isNaN(a) || isNaN(b))
            throw new Error("Invalid number in add expression");
        return { op: "add", args: [a, b] };
    }
    if (trimmed.includes("*")) {
        const parts = trimmed.split("*").map((s) => s.trim());
        if (parts.length !== 2)
            throw new Error("Only binary multiply supported");
        const a = parseFloat(parts[0]);
        const b = parseFloat(parts[1]);
        if (isNaN(a) || isNaN(b))
            throw new Error("Invalid number in multiply expression");
        return { op: "multiply", args: [a, b] };
    }
    throw new Error(`Unsupported expression format: ${input}`);
}
