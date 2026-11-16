import { effectMemberOf, type Rule } from "../Ast.ts";

// https://effect.website/docs/v4/code-style/guidelines, "Using runMain": a
// program is run once, at its entry point, by the platform's `runMain`. The
// Worker's entry point is run by Alchemy. Tests and test doubles run effects
// themselves; the rule is off for them in .oxlintrc.json.

export const runAtTheEdge: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Run effects only at an entry point, through the platform's runMain." },
    messages: {
      run: "`Effect.{{name}}` runs an effect in the middle of a program. Return the effect, and let the entry point run it with `NodeRuntime.runMain`.",
    },
  },
  create: (context) => ({
    MemberExpression: (node) => {
      const member = effectMemberOf(context, node);
      if (member?.module === "Effect" && /^run(Promise|Sync|Fork|Callback)/.test(member.name)) {
        context.report({ node, messageId: "run", data: member });
      }
    },
  }),
};
