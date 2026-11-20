import { effectMemberOf } from "../Ast.ts";
import type { Rule } from "../Ast.ts";

// https://effect.website/docs/v4/code-style/dual: one operation reads best with
// the data first; `.pipe` is for a chain of them.

/** Modules whose functions all take their data first as well as last. */
const dualModules = new Set(["Effect", "Layer"]);

export const preferDataFirst: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "Call a single Effect or Layer operation with its data first instead of through `.pipe`." },
    messages: {
      dataFirst:
        "A pipe with one step: call `{{module}}.{{name}}` with the value as its first argument, and keep `.pipe` for two or more steps.",
    },
  },
  create: (context) => ({
    CallExpression: (node) => {
      const callee = node.callee;
      if (callee.type !== "MemberExpression" || callee.computed || callee.property.name !== "pipe") {
        return;
      }
      const [step, ...more] = node.arguments;
      if (step === undefined || more.length > 0) {
        return;
      }
      const member = effectMemberOf(context, step.type === "CallExpression" ? step.callee : step);
      if (member === undefined || !dualModules.has(member.module)) {
        return;
      }
      context.report({ node, messageId: "dataFirst", data: member });
    },
  }),
};
