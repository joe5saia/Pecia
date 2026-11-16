import { type Context, effectMemberOf, type Node, type Rule } from "../Ast.ts";

// https://effect.website/docs/v4/code-style/control-flow, "Looping": an effect
// run once per element of an iterable is `Effect.forEach`, which says in one
// place whether the results are kept and how many run at once. A `while` loop
// that carries state stays a loop.

const isFunction = (node: Node): boolean =>
  node.type === "FunctionExpression" || node.type === "FunctionDeclaration" || node.type === "ArrowFunctionExpression";

/** The functions of the Effect module that run a generator as an effect. */
const generators = new Set(["gen", "fn", "fnUntraced"]);

/** The `for...of` or `for...in` around `node` in the body of the Effect generator it belongs to, if there is one. */
const loopAround = (context: Context, node: Node): Node | undefined => {
  let loop: Node | undefined;
  let current = node.parent;
  while (current !== null && current.type !== "Program" && !isFunction(current)) {
    if (current.type === "ForOfStatement" || current.type === "ForInStatement") loop ??= current;
    current = current.parent;
  }
  if (loop === undefined || current === null || current.type === "Program") return undefined;
  const call = current.parent;
  if (call === null || call.type !== "CallExpression") return undefined;
  // `Effect.gen(function* () {})`, `Effect.fn(function* () {})` and `Effect.fn("name")(function* () {})`.
  const callee = call.callee.type === "CallExpression" ? call.callee.callee : call.callee;
  const name = effectMemberOf(context, callee)?.name;
  return name !== undefined && generators.has(name) ? loop : undefined;
};

export const preferForEach: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "Run an effect for each element of an iterable with Effect.forEach instead of a `for` loop." },
    messages: {
      forEach:
        "Run an effect for each element with `Effect.forEach(items, (item) => ...)`; pass `{ discard: true }` when the results are not used.",
    },
  },
  create: (context) => ({
    YieldExpression: (node) => {
      if (node.delegate && loopAround(context, node) !== undefined) context.report({ node, messageId: "forEach" });
    },
  }),
};
