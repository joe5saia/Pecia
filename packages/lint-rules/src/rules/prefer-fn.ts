import { effectMemberOf, isInlineFunction } from "../Ast.ts";
import type { Context, Node, Rule } from "../Ast.ts";

// The Effect library's own guidance (node_modules/effect/AGENTS.md, "Using
// Effect.fn and Effect.fnUntraced"): a reusable function whose body is a
// generator is `Effect.fn("name")(function* (...) {})`, which names it in
// stack traces and spans, or `Effect.fnUntraced` where a span is no use. A
// function that only wraps and returns `Effect.gen` gets neither.
//
// Only a function given a name with `const` is reported. An inline callback
// takes its parameter types from where it is passed, which `Effect.fn` cannot
// see, so it stays an arrow function around `Effect.gen`.

/** `Effect.gen(...)`, or `Effect.gen(...).pipe(...)`. */
const isGen = (context: Context, node: Node): boolean => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.name === "pipe") {
    return isGen(context, callee.object);
  }
  const member = effectMemberOf(context, callee);
  return member?.module === "Effect" && member.name === "gen";
};

/** What a function returns, when returning it is all the function does. */
const onlyReturnOf = (fn: Node): Node | undefined => {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") {
    return undefined;
  }
  const body = fn.body;
  if (body === null) {
    return undefined;
  }
  if (body.type !== "BlockStatement") {
    return body;
  }
  const [statement, ...more] = body.body;
  if (statement === undefined || more.length > 0 || statement.type !== "ReturnStatement") {
    return undefined;
  }
  return statement.argument ?? undefined;
};

export const preferFn: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Write a named function whose body is a generator with Effect.fn instead of wrapping Effect.gen.",
    },
    messages: {
      fn: 'A function that only returns `Effect.gen` is `Effect.fn("name")(function* (...) {})`, or `Effect.fnUntraced` where a span is no use. What was piped after the generator goes in as further arguments.',
    },
  },
  create: (context) => ({
    VariableDeclarator: (node) => {
      const init = node.init;
      if (init === null || !isInlineFunction(init)) {
        return;
      }
      const returned = onlyReturnOf(init);
      if (returned !== undefined && isGen(context, returned)) {
        context.report({ node: init, messageId: "fn" });
      }
    },
  }),
};
