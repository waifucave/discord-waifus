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

type Scope = { names: Set<string>; parent: Scope | undefined };

const scopeOf = (parent: Scope | undefined, names: Iterable<string> = []): Scope => ({ names: new Set(names), parent });

/** The names a binding pattern declares (its default values are not names). */
function patternNames(node: AnyNode | null | undefined, out: Set<string>): void {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      out.add(node["name"] as string);
      return;
    case "ObjectPattern":
      for (const property of node["properties"] as AnyNode[]) patternNames((property.type === "RestElement" ? property["argument"] : property["value"]) as AnyNode, out);
      return;
    case "ArrayPattern":
      for (const element of node["elements"] as Array<AnyNode | null>) patternNames(element, out);
      return;
    case "RestElement":
      patternNames(node["argument"] as AnyNode, out);
      return;
    case "AssignmentPattern":
      patternNames(node["left"] as AnyNode, out);
      return;
    default:
      return;
  }
}

/** `var` names anywhere in a function's body (hoisted to it), never inside an inner function. */
function varNames(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) varNames(item, out);
    return;
  }
  if (!isNode(value)) return;
  if (value.type === "FunctionDeclaration" || value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression" || value.type === "ClassDeclaration" || value.type === "ClassExpression") return;
  if (value.type === "VariableDeclaration" && value["kind"] === "var") {
    for (const declarator of value["declarations"] as AnyNode[]) patternNames(declarator["id"] as AnyNode, out);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    varNames(child, out);
  }
}

/** The names a statement list declares for its own block: `let`, `const`, classes and functions. */
function lexicalNames(statements: readonly AnyNode[]): Set<string> {
  const out = new Set<string>();
  for (const statement of statements) {
    if (statement.type === "VariableDeclaration" && statement["kind"] !== "var") for (const declarator of statement["declarations"] as AnyNode[]) patternNames(declarator["id"] as AnyNode, out);
    else if ((statement.type === "ClassDeclaration" || statement.type === "FunctionDeclaration") && statement["id"]) out.add((statement["id"] as AnyNode)["name"] as string);
  }
  return out;
}

/**
 * The names a function uses that no scope inside it declares, resolved scope by scope (a name bound
 * in an inner function, block or `catch` is not visible outside it).
 */
export function freeNames(fn: AnyNode): Set<string> {
  const free = new Set<string>();
  const use = (name: string, scope: Scope) => {
    for (let at: Scope | undefined = scope; at; at = at.parent) if (at.names.has(name)) return;
    free.add(name);
  };
  // A pattern's default values and computed keys are expressions; a member target is one too.
  const pattern = (node: AnyNode | null | undefined, scope: Scope): void => {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
        return;
      case "ObjectPattern":
        for (const property of node["properties"] as AnyNode[]) {
          if (property.type === "RestElement") pattern(property["argument"] as AnyNode, scope);
          else {
            if (property["computed"]) walk(property["key"], scope);
            pattern(property["value"] as AnyNode, scope);
          }
        }
        return;
      case "ArrayPattern":
        for (const element of node["elements"] as Array<AnyNode | null>) pattern(element, scope);
        return;
      case "RestElement":
        pattern(node["argument"] as AnyNode, scope);
        return;
      case "AssignmentPattern":
        pattern(node["left"] as AnyNode, scope);
        walk(node["right"], scope);
        return;
      default:
        walk(node, scope);
    }
  };
  const visitFunction = (node: AnyNode, outer: Scope): void => {
    const own = new Set<string>();
    if (node.type !== "ArrowFunctionExpression") own.add("arguments");
    // A function expression's own name is visible inside it only.
    if (node.type === "FunctionExpression" && node["id"]) own.add((node["id"] as AnyNode)["name"] as string);
    for (const param of node["params"] as AnyNode[]) patternNames(param, own);
    const params = scopeOf(outer, own);
    for (const param of node["params"] as AnyNode[]) pattern(param, params);
    const body = node["body"] as AnyNode;
    if (body.type !== "BlockStatement") {
      walk(body, params);
      return;
    }
    const names = new Set<string>();
    varNames(body["body"], names);
    for (const name of lexicalNames(body["body"] as AnyNode[])) names.add(name);
    const inside = scopeOf(params, names);
    for (const statement of body["body"] as AnyNode[]) walk(statement, inside);
  };
  const walk = (value: unknown, scope: Scope): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, scope);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    switch (node.type) {
      case "Identifier":
        use(node["name"] as string, scope);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        // A declaration's name was declared in its block already.
        visitFunction(node, scope);
        return;
      case "ClassDeclaration":
      case "ClassExpression": {
        const inner = scopeOf(scope, node["id"] ? [(node["id"] as AnyNode)["name"] as string] : []);
        walk(node["superClass"], scope);
        walk(node["body"], inner);
        return;
      }
      case "BlockStatement": {
        const inner = scopeOf(scope, lexicalNames(node["body"] as AnyNode[]));
        for (const statement of node["body"] as AnyNode[]) walk(statement, inner);
        return;
      }
      case "VariableDeclaration":
        for (const declarator of node["declarations"] as AnyNode[]) {
          pattern(declarator["id"] as AnyNode, scope);
          walk(declarator["init"], scope);
        }
        return;
      case "ForStatement": {
        const init = node["init"] as AnyNode | null;
        const inner = scopeOf(scope, init && init.type === "VariableDeclaration" && init["kind"] !== "var" ? lexicalNames([init]) : []);
        walk(init, inner);
        walk(node["test"], inner);
        walk(node["update"], inner);
        walk(node["body"], inner);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const left = node["left"] as AnyNode;
        const inner = scopeOf(scope, left.type === "VariableDeclaration" && left["kind"] !== "var" ? lexicalNames([left]) : []);
        if (left.type === "VariableDeclaration") walk(left, inner);
        else pattern(left, inner);
        walk(node["right"], inner);
        walk(node["body"], inner);
        return;
      }
      case "CatchClause": {
        const names = new Set<string>();
        patternNames(node["param"] as AnyNode | null, names);
        const inner = scopeOf(scope, names);
        pattern(node["param"] as AnyNode | null, inner);
        walk(node["body"], inner);
        return;
      }
      case "SwitchStatement": {
        walk(node["discriminant"], scope);
        const cases = node["cases"] as AnyNode[];
        const inner = scopeOf(scope, lexicalNames(cases.flatMap((item) => item["consequent"] as AnyNode[])));
        for (const item of cases) {
          walk(item["test"], inner);
          walk(item["consequent"], inner);
        }
        return;
      }
      case "MemberExpression":
        walk(node["object"], scope);
        if (node["computed"]) walk(node["property"], scope);
        return;
      case "Property":
      case "PropertyDefinition":
      case "MethodDefinition":
        if (node["computed"]) walk(node["key"], scope);
        walk(node["value"], scope);
        return;
      case "LabeledStatement":
        walk(node["body"], scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
        return;
      default:
        for (const [key, child] of Object.entries(node)) {
          if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
          walk(child, scope);
        }
    }
  };
  walk(fn, scopeOf(undefined));
  return free;
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
  if (outside.length > 0) return { ok: false, error: `${CLOSURE_REFUSED} (it uses ${outside.slice(0, 3).join(", ")}); write the value into it, like ${correctedFilter(source, outside)}` };
  return { ok: true };
}

/** Her function with each outside name replaced by a placeholder for its value (§32.3a: one corrected filter). */
function correctedFilter(source: string, names: readonly string[]): string {
  let fixed = source;
  for (const name of names) {
    const escaped = name.replace(/[$]/gu, "\\$&");
    fixed = fixed.replace(new RegExp(`(?<![.\\w$])${escaped}(?![\\w$])`, "gu"), JSON.stringify(`<the value of ${name}>`));
  }
  fixed = fixed.replace(/\s+/gu, " ").trim();
  return fixed.length > 300 ? `${fixed.slice(0, 299)}…` : fixed;
}
