import { parse } from "@babel/parser";
import { isNode, type Node } from "@babel/types";

export function* nodesOf(text: string): Iterable<Node> {
  yield* walk(parse(text, { sourceType: "module", plugins: ["typescript"] }).program);
}

function* walk(value: unknown): Iterable<Node> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
  } else if (isNode(value)) {
    yield value;
    for (const child of Object.values(value)) yield* walk(child);
  }
}

const ENV_HOLDERS = new Set(["process", "Bun"]);

const PROCESS_MODULES = new Set(["process", "node:process"]);

function namesEnv(key: Node): boolean {
  return (
    (key.type === "Identifier" && key.name === "env") || (key.type === "StringLiteral" && key.value === "env")
  );
}

function holdsEnv(node: Node): boolean {
  return (
    (node.type === "Identifier" && ENV_HOLDERS.has(node.name)) ||
    (node.type === "MetaProperty" && node.meta.name === "import")
  );
}

function isEnvRead(node: Node): boolean {
  return (
    ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      holdsEnv(node.object) &&
      namesEnv(node.property)) ||
    (node.type === "VariableDeclarator" &&
      node.init != null &&
      holdsEnv(node.init) &&
      node.id.type === "ObjectPattern" &&
      node.id.properties.some((property) => property.type === "ObjectProperty" && namesEnv(property.key))) ||
    (node.type === "ImportDeclaration" &&
      PROCESS_MODULES.has(node.source.value) &&
      node.specifiers.some(
        (specifier) => specifier.type === "ImportSpecifier" && namesEnv(specifier.imported),
      ))
  );
}

export function readsEnv(text: string): boolean {
  return [...nodesOf(text)].some(isEnvRead);
}
