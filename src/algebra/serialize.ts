import type { ExprNode } from "./ast.js";

// All 12 known ExprNode ops
const KNOWN_OPS = new Set([
  "leaf",
  "sigma",
  "tau",
  "delta",
  "pi",
  "rho",
  "gamma",
  "kappa",
  "combine",
  "synthesize",
  "resolve",
  "aggregate",
]);

// Required fields per op (beyond "op" itself).
// "src" is checked separately for non-leaf ops.
const REQUIRED_FIELDS: Record<string, string[]> = {
  leaf: ["corpusId"],
  sigma: ["pred", "src"],
  tau: ["mode", "src"],
  delta: ["policy", "src"],
  pi: ["fields", "src"],
  rho: ["fn", "query", "src"],
  gamma: ["depth", "src"],
  kappa: ["fmt", "maxTokens", "src"],
  combine: ["rule", "src"],
  synthesize: ["subject", "key", "rule", "src"],
  resolve: ["policy", "src"],
  aggregate: ["fn", "src"],
};

/**
 * Recursively sort all object keys (alphabetically) while preserving array
 * element order.  This ensures byte-identical output for structurally equal
 * nodes regardless of the order in which properties were inserted.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}

/**
 * Produce a stable JSON string for an ExprNode.
 * Object keys are sorted at every level of nesting so two structurally equal
 * nodes always produce byte-identical output.
 */
export function serializeExpr(node: ExprNode): string {
  return JSON.stringify(canonicalize(node));
}

/**
 * Validate that `raw` is a well-formed ExprNode, recursing into nested `src`
 * chains.  Throws a descriptive Error on any violation.
 */
function validateNode(raw: unknown): ExprNode {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ExprNode must be a non-null object");
  }
  const obj = raw as Record<string, unknown>;
  const { op } = obj;
  if (typeof op !== "string") {
    throw new Error(`ExprNode.op must be a string, got ${JSON.stringify(op)}`);
  }
  if (!KNOWN_OPS.has(op)) {
    throw new Error(`Unknown ExprNode op: "${op}"`);
  }

  const required = REQUIRED_FIELDS[op];
  for (const field of required) {
    if (!(field in obj)) {
      throw new Error(`ExprNode op "${op}" is missing required field "${field}"`);
    }
  }

  // Recursively validate nested src (all ops except "leaf" have src)
  if (op !== "leaf") {
    validateNode(obj["src"]);
  }

  return obj as unknown as ExprNode;
}

/**
 * Parse a JSON string produced by `serializeExpr` (or any compatible source)
 * back into an `ExprNode`.  Throws on invalid JSON, unknown ops, or missing
 * required fields.
 */
export function parseExpr(s: string): ExprNode {
  // JSON.parse already throws on malformed input
  const raw: unknown = JSON.parse(s);
  return validateNode(raw);
}
