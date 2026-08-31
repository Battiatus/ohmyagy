import assert from "node:assert/strict";
import test from "node:test";
import { add, multiply, fibonacci } from "../src/math.js";
import { parseExpression } from "../src/parser.js";
import { evaluatePipeline } from "../src/pipeline.js";

test("visible: math basic operations", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(multiply(4, 5), 20);
  assert.equal(fibonacci(5), 5);
});

test("visible: parser basic expressions", () => {
  const p1 = parseExpression("2 + 3");
  assert.equal(p1.op, "add");
  assert.deepEqual(p1.args, [2, 3]);

  const p2 = parseExpression("4 * 5");
  assert.equal(p2.op, "multiply");
  assert.deepEqual(p2.args, [4, 5]);

  const p3 = parseExpression("fib(5)");
  assert.equal(p3.op, "fib");
  assert.deepEqual(p3.args, [5]);
});

test("visible: pipeline evaluates sequence", () => {
  const res = evaluatePipeline(["2 + 3", "4 * 5", "fib(5)"]);
  assert.equal(res.steps.length, 3);
  assert.equal(res.aggregateSum, 5 + 20 + 5); // 30
  assert.equal(res.aggregateProduct, 5 * 20 * 5); // 500
});
