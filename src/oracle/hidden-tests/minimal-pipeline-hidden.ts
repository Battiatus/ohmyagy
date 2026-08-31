import assert from "node:assert/strict";

export interface TestRunResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface HiddenTestModule {
  runHiddenTests(moduleExports: {
    math: { add: Function; multiply: Function; fibonacci: Function };
    parser: { parseExpression: Function };
    pipeline: { evaluatePipeline: Function };
  }): TestRunResult[];
}

export function runHiddenPipelineTests(modules: {
  math: { add: Function; multiply: Function; fibonacci: Function };
  parser: { parseExpression: Function };
  pipeline: { evaluatePipeline: Function };
}): TestRunResult[] {
  const results: TestRunResult[] = [];

  // Test 1: Fibonacci negative constraint
  try {
    let threw = false;
    try {
      modules.math.fibonacci(-1);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "fibonacci(-1) must throw Error");
    results.push({ name: "hidden: fibonacci negative rejection", passed: true });
  } catch (err) {
    results.push({
      name: "hidden: fibonacci negative rejection",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Test 2: Fibonacci large input & base cases
  try {
    assert.equal(modules.math.fibonacci(0), 0);
    assert.equal(modules.math.fibonacci(1), 1);
    assert.equal(modules.math.fibonacci(20), 6765);
    results.push({ name: "hidden: fibonacci edge cases and scalability", passed: true });
  } catch (err) {
    results.push({
      name: "hidden: fibonacci edge cases and scalability",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Test 3: Parser decimal numbers and whitespace tolerance
  try {
    const p1 = modules.parser.parseExpression("  10.5  +  4.5  ");
    assert.equal(p1.op, "add");
    assert.deepEqual(p1.args, [10.5, 4.5]);

    const p2 = modules.parser.parseExpression("  3.2 * 2.0  ");
    assert.equal(p2.op, "multiply");
    assert.deepEqual(p2.args, [3.2, 2.0]);
    results.push({ name: "hidden: parser decimal & whitespace tolerance", passed: true });
  } catch (err) {
    results.push({
      name: "hidden: parser decimal & whitespace tolerance",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Test 4: Parser syntax error handling
  try {
    let invalidThrew = false;
    try {
      modules.parser.parseExpression("invalid + syntax + extra");
    } catch {
      invalidThrew = true;
    }
    assert.equal(invalidThrew, true, "Malformed expression must throw Error");
    results.push({ name: "hidden: parser invalid syntax rejection", passed: true });
  } catch (err) {
    results.push({
      name: "hidden: parser invalid syntax rejection",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Test 5: Pipeline empty and composite precision
  try {
    const emptyRes = modules.pipeline.evaluatePipeline([]);
    assert.equal(emptyRes.steps.length, 0);
    assert.equal(emptyRes.aggregateSum, 0);
    assert.equal(emptyRes.aggregateProduct, 0);

    const compRes = modules.pipeline.evaluatePipeline(["10.5 + 4.5", "fib(10)"]);
    assert.equal(compRes.aggregateSum, 15 + 55);
    assert.equal(compRes.aggregateProduct, 15 * 55);
    results.push({ name: "hidden: pipeline empty and precision evaluation", passed: true });
  } catch (err) {
    results.push({
      name: "hidden: pipeline empty and precision evaluation",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}
