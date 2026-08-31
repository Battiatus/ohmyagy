/**
 * Mutant 2: Naive parser that only handles integer single-digit values without whitespace.
 * - Passes visible test: "2 + 3", "4 * 5", "fib(5)".
 * - FAILS hidden tests:
 *   - Fails on decimals: "  10.5  +  4.5  ".
 *   - Fails on syntax error detection: "invalid + syntax + extra".
 */
export function parseExpression(input) {
    if (input.startsWith("fib(")) {
        const num = parseInt(input.slice(4, -1), 10);
        return { op: "fib", args: [num] };
    }
    if (input.includes("+")) {
        const parts = input.split("+");
        return { op: "add", args: [parseInt(parts[0], 10), parseInt(parts[1], 10)] };
    }
    if (input.includes("*")) {
        const parts = input.split("*");
        return { op: "multiply", args: [parseInt(parts[0], 10), parseInt(parts[1], 10)] };
    }
    return { op: "add", args: [0, 0] };
}
