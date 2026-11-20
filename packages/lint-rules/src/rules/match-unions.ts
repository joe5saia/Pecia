import type { Context, Node, Rule } from "../Ast.ts";

// https://effect.website/docs/v4/code-style/pattern-matching: branch on the
// cases of a union with `Match` and an exhaustive finalizer, so a new case is
// a compile error. One `if` that guards or returns early is not a branch on
// every case and stays as it is.

const isText = (node: Node): boolean => node.type === "Literal" && typeof node.value === "string";

/** `x.status === "landed"` as `"x.status"`: what a test compares with a string, if that is what it does. */
const subjectOf = (context: Context, test: Node): string | undefined => {
  if (test.type !== "BinaryExpression" || test.operator !== "===") {
    return undefined;
  }
  if (isText(test.right)) {
    return context.sourceCode.getText(test.left);
  }
  if (isText(test.left)) {
    return context.sourceCode.getText(test.right);
  }
  return undefined;
};

export const matchUnions: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "Branch on the cases of a union with Match instead of `switch` or an `else if` chain." },
    messages: {
      match:
        "Branch on the cases with Match and an exhaustive finalizer (`Match.valueTags`, `Match.discriminatorsExhaustive`, `Match.exhaustive`), so a new case is a compile error.",
    },
  },
  create: (context) => ({
    SwitchStatement: (node) => context.report({ node, messageId: "match" }),
    IfStatement: (node) => {
      const next = node.alternate;
      if (next === null || next.type !== "IfStatement") {
        return;
      }
      const subject = subjectOf(context, node.test);
      if (subject !== undefined && subject === subjectOf(context, next.test)) {
        context.report({ node: next, messageId: "match" });
      }
    },
  }),
};
