import { add, multiply, fibonacci } from "./math.js";
import { parseExpression } from "./parser.js";
export function evaluatePipeline(expressions) {
    const steps = [];
    let sum = 0;
    let prod = 1;
    for (const expr of expressions) {
        const parsed = parseExpression(expr);
        let val;
        switch (parsed.op) {
            case "add":
                val = add(parsed.args[0], parsed.args[1]);
                break;
            case "multiply":
                val = multiply(parsed.args[0], parsed.args[1]);
                break;
            case "fib":
                val = fibonacci(parsed.args[0]);
                break;
            default:
                throw new Error(`Unknown operator in pipeline`);
        }
        steps.push({ expression: expr, result: val });
        sum += val;
        prod *= val;
    }
    return {
        steps,
        aggregateSum: sum,
        aggregateProduct: expressions.length === 0 ? 0 : prod,
    };
}
