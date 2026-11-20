import { effectMemberOf, isPipeArgument } from "../Ast.ts";
import type { CallExpression, Context, Node, Rule } from "../Ast.ts";

// https://effect.website/docs/v4/code-style/guidelines, "Avoid Tacit Usage".
//
// A linter without types cannot tell a function from any other value, so the
// rule knows the combinators whose arguments after the data are functions, and
// the option names that hold one.

/**
 * Combinators that take functions, by name in any Effect module (`Effect.map`,
 * `Option.map`, `Stream.map`). The number counts the arguments before the
 * functions that are not one, such as the tag of `catchTag`.
 */
const combinators: Readonly<Record<string, number>> = {
  map: 0,
  flatMap: 0,
  mapError: 0,
  tapError: 0,
  catch: 0,
  catchIf: 0,
  catchCause: 0,
  catchDefect: 0,
  catchTag: 1,
  forEach: 0,
  filter: 0,
  filterOrFail: 0,
  orElseSucceed: 0,
  sync: 0,
  promise: 0,
  suspend: 0,
};

/** Options of Effect functions that hold a function, as in `Effect.retry({ while })` and `Effect.tryPromise({ try, catch })`. */
const functionOptions = new Set(["try", "catch", "while", "until", "onSuccess", "onFailure"]);

/** A function passed by its name: `f` or `Module.f`, as opposed to `(x) => f(x)`. */
const isReference = (node: Node): boolean => node.type === "Identifier" || node.type === "MemberExpression";

const check = (context: Context, call: CallExpression): void => {
  const member = effectMemberOf(context, call.callee);
  if (member === undefined) {
    return;
  }
  const report = (node: Node) => context.report({ node, messageId: "tacit" });

  for (const argument of call.arguments) {
    if (argument.type !== "ObjectExpression") {
      continue;
    }
    for (const property of argument.properties) {
      if (property.type !== "Property" || property.key.type !== "Identifier") {
        continue;
      }
      if (functionOptions.has(property.key.name) && isReference(property.value)) {
        report(property.value);
      }
    }
  }

  const leading = combinators[member.name];
  if (leading === undefined) {
    return;
  }
  // Called on its own, `Effect.map(effect, f)` takes the effect first. In a pipe, `Effect.map(f)` does not.
  const data = !isPipeArgument(call) && call.arguments.length > 1 ? 1 : 0;
  for (const argument of call.arguments.slice(data + leading)) {
    if (isReference(argument)) {
      report(argument);
    }
  }
};

export const noTacit: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Write out the functions passed to Effect combinators instead of passing them by name." },
    messages: {
      tacit:
        "Write the function out, as in `(x) => f(x)`. A function passed by name can lose its generics and overloads, and its stack traces are harder to read.",
    },
  },
  create: (context) => ({ CallExpression: (node) => check(context, node) }),
};
