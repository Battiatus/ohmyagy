export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

/**
 * Mutant 1: Naive recursive fibonacci.
 * - Passes visible test: fibonacci(5) === 5.
 * - FAILS hidden tests:
 *   - Does not throw on negative input (e.g. fibonacci(-1)).
 *   - Stack overflow / exponential complexity on fibonacci(20).
 */
export function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
