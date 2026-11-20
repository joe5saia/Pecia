import type { RuleTester } from "oxlint/plugins-dev";

// What the rules share: the types of oxlint's ESLint-compatible plugin API, which
// the package only exposes through `RuleTester`, and how a rule recognizes a call
// into an Effect module.

/** A rule written against ESLint's `create` API, which oxlint runs as is. */
export type Rule = Extract<Parameters<RuleTester["run"]>[1], { create: unknown }>;
export type Context = Parameters<Rule["create"]>[0];
export type Node = Parameters<Context["sourceCode"]["getScope"]>[0];
type Scope = ReturnType<Context["sourceCode"]["getScope"]>;
type Variable = Scope["variables"][number];

export type CallExpression = Extract<Node, { type: "CallExpression" }>;
export type IdentifierReference = Extract<Node, { type: "Identifier"; parent: Node }>;

/** The variable an identifier refers to, when it is declared in this file. */
export const variableOf = (context: Context, identifier: IdentifierReference): Variable | undefined => {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return undefined;
};

const isEffectPackage = (source: string): boolean =>
  source === "effect" || source.startsWith("effect/") || source.startsWith("@effect/");

/**
 * The Effect module an expression names, such as `"Effect"` for the `Effect` of
 * `import * as Effect from "effect/Effect"` or of `import { Effect } from "effect"`.
 */
export const effectModuleOf = (context: Context, node: Node): string | undefined => {
  if (node.type !== "Identifier") {
    return undefined;
  }
  const definition = variableOf(context, node)?.defs[0];
  if (definition === undefined || definition.type !== "ImportBinding") {
    return undefined;
  }
  const declaration = definition.parent;
  if (declaration === null || declaration.type !== "ImportDeclaration") {
    return undefined;
  }
  const source = declaration.source.value;
  if (!isEffectPackage(source)) {
    return undefined;
  }
  const specifier = definition.node;
  if (specifier.type === "ImportNamespaceSpecifier") {
    return source.slice(source.lastIndexOf("/") + 1);
  }
  if (specifier.type !== "ImportSpecifier") {
    return undefined;
  }
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
};

/** `Effect.map` as `{ module: "Effect", name: "map" }`, for a member of an Effect module. */
export const effectMemberOf = (
  context: Context,
  node: Node,
): { readonly module: string; readonly name: string } | undefined => {
  if (node.type !== "MemberExpression" || node.computed || node.property.type !== "Identifier") {
    return undefined;
  }
  const module = effectModuleOf(context, node.object);
  return module === undefined ? undefined : { module, name: node.property.name };
};

export const isInlineFunction = (node: Node): boolean =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";

/** Whether `call` is an argument of `x.pipe(...)` or `pipe(x, ...)`, where combinators take their data last. */
export const isPipeArgument = (call: CallExpression): boolean => {
  const parent = call.parent;
  if (parent.type !== "CallExpression" || parent.callee === call) {
    return false;
  }
  const callee = parent.callee;
  // The first argument of `pipe(x, ...)` is the data, not a step.
  if (callee.type === "Identifier") {
    return callee.name === "pipe" && parent.arguments[0] !== call;
  }
  return callee.type === "MemberExpression" && !callee.computed && callee.property.name === "pipe";
};
