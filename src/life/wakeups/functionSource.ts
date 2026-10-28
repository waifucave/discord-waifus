// Her filter and check functions as source text (Living cast spec §30.1): each is stored as text and
// runs in a fresh sandbox context for every event, so it must be self-contained. Before one is
// saved it is parsed here (acorn, exact pin; parsing never runs it): it must be one plain function
// (an arrow or `function`, not async or a generator), at most 8 KiB, and every name it uses must be
// its own (parameters, its own variables) or a JavaScript built-in. A name from outside (a variable
// of her script) is refused: `filters can't use variables from outside them; put what they need
// inside`. The sandbox then compiles it once more (its own syntax errors, with lines).

import { parse, type Node } from "acorn";

/** Largest function source (§30.3). */
export const MAX_FUNCTION_SOURCE_BYTES = 8 * 1024;

/** What QuickJS's global object holds (tests/sandboxIsolation.test.ts lists the same names). */
export const SANDBOX_GLOBALS: ReadonlySet<string> = new Set([
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "InternalError", "AggregateError",
  "Array", "Object", "Function", "Iterator", "parseInt", "parseFloat", "isNaN", "isFinite", "decodeURI", "decodeURIComponent",
  "encodeURI", "encodeURIComponent", "escape", "unescape", "Infinity", "NaN", "undefined", "eval", "Number", "Boolean", "String",
  "Math", "Reflect", "Symbol", "globalThis", "BigInt", "Date", "RegExp", "JSON", "Proxy", "Map", "Set", "WeakMap", "WeakSet",
  "ArrayBuffer", "SharedArrayBuffer", "Uint8ClampedArray", "Int8Array", "Uint8Array", "Int16Array", "Uint16Array", "Int32Array",
  "Uint32Array", "BigInt64Array", "BigUint64Array", "Float16Array", "Float32Array", "Float64Array", "DataView", "Promise",
  "WeakRef", "FinalizationRegistry", "arguments"
]);

export const CLOSURE_REFUSED = "filters can't use variables from outside them; put what they need inside";

export type SourceCheck = { ok: true } | { ok: false; error: string; line?: number };

type AnyNode = Node & Record<string, unknown>;

const isNode = (value: unknown): value is AnyNode => typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** Names a binding pattern declares; its default values and computed keys are walked as expressions. */
function bindPattern(node: AnyNode | null | undefined, bound: Set<string>, walk: (node: unknown) => void): void {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      bound.add(node["name"] as string);
      return;
    case "ObjectPattern":
      for (const property of node["properties"] as AnyNode[]) {
        if (property.type === "RestElement") bindPattern(property["argument"] as AnyNode, bound, walk);
        else {
          if (property["computed"]) walk(property["key"]);
          bindPattern(property["value"] as AnyNode, bound, walk);
        }
      }
      return;
    case "ArrayPattern":
      for (const element of node["elements"] as Array<AnyNode | null>) bindPattern(element, bound, walk);
      return;
    case "RestElement":
      bindPattern(node["argument"] as AnyNode, bound, walk);
      return;
    case "AssignmentPattern":
      bindPattern(node["left"] as AnyNode, bound, walk);
      walk(node["right"]);
      return;
    default:
      // A member expression as a target (only in assignments): walked as an expression.
      walk(node);
  }
}

/**
 * The names a function uses that it does not declare anywhere inside itself. (A name declared in an
 * inner block and used outside it is not caught here; it fails when it runs, as an error.)
 */
export function freeNames(fn: AnyNode): Set<string> {
  const bound = new Set<string>();
  const used = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    switch (node.type) {
      case "Identifier":
        used.add(node["name"] as string);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node["id"]) bound.add((node["id"] as AnyNode)["name"] as string);
        for (const param of node["params"] as AnyNode[]) bindPattern(param, bound, walk);
        walk(node["body"]);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node["id"]) bound.add((node["id"] as AnyNode)["name"] as string);
        walk(node["superClass"]);
        walk(node["body"]);
        return;
      case "VariableDeclarator":
        bindPattern(node["id"] as AnyNode, bound, walk);
        walk(node["init"]);
        return;
      case "CatchClause":
        bindPattern(node["param"] as AnyNode | null, bound, walk);
        walk(node["body"]);
        return;
      case "MemberExpression":
        walk(node["object"]);
        if (node["computed"]) walk(node["property"]);
        return;
      case "Property":
      case "PropertyDefinition":
      case "MethodDefinition":
        if (node["computed"]) walk(node["key"]);
        walk(node["value"]);
        return;
      case "LabeledStatement":
        walk(node["body"]);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
        return;
      default:
        for (const [key, child] of Object.entries(node)) {
          if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
          walk(child);
        }
    }
  };
  walk(fn);
  return new Set([...used].filter((name) => !bound.has(name)));
}

/** Checks one function source (her filter or check): shape, size and self-containment. */
export function checkFunctionSource(source: string): SourceCheck {
  if (Buffer.byteLength(source, "utf8") > MAX_FUNCTION_SOURCE_BYTES) return { ok: false, error: `the function is over ${MAX_FUNCTION_SOURCE_BYTES / 1024} KiB; make it shorter` };
  if (/\[native code\]/u.test(source)) return { ok: false, error: "give your own function, like (msg, state) => msg.text.includes(\"hi\")" };
  let program: AnyNode;
  try {
    // Wrapped in parentheses on the first line, so its lines are hers.
    program = parse(`(${source}\n)`, { ecmaVersion: "latest", sourceType: "script", locations: true }) as unknown as AnyNode;
  } catch (error) {
    const loc = (error as { loc?: { line: number } }).loc;
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s*\(\d+:\d+\)$/u, "");
    return { ok: false, error: `SyntaxError: ${message}`, ...(loc ? { line: loc.line } : {}) };
  }
  const body = program["body"] as AnyNode[];
  const expression = body.length === 1 && body[0]!.type === "ExpressionStatement" ? (body[0]!["expression"] as AnyNode) : undefined;
  if (!expression || (expression.type !== "ArrowFunctionExpression" && expression.type !== "FunctionExpression")) {
    return { ok: false, error: "give one function, like (msg, state) => msg.text.includes(\"hi\")" };
  }
  if (expression["async"] || expression["generator"]) return { ok: false, error: "the function can't be async or a generator" };
  const outside = [...freeNames(expression)].filter((name) => !SANDBOX_GLOBALS.has(name));
  if (outside.length > 0) return { ok: false, error: `${CLOSURE_REFUSED} (it uses ${outside.slice(0, 3).join(", ")})` };
  return { ok: true };
}
