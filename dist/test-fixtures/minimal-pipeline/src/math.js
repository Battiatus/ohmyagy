export function add(a, b) {
    return a + b;
}
export function multiply(a, b) {
    return a * b;
}
export function fibonacci(n) {
    if (n < 0) {
        throw new Error("Fibonacci index must be non-negative");
    }
    if (n === 0)
        return 0;
    if (n === 1)
        return 1;
    let prev = 0;
    let curr = 1;
    for (let i = 2; i <= n; i++) {
        const next = prev + curr;
        prev = curr;
        curr = next;
    }
    return curr;
}
