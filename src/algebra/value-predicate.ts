import { z } from "zod";
import { canonicalizeValue } from "../core/value.js";
import type { Value } from "../core/value.js";
import type { ClaimSchema } from "../catalog/schema.js";

export type ValuePredicate =
  | { op: "valueEq"; path: string; value: Value }
  | { op: "valueGt"; path: string; value: number }
  | { op: "valueIn"; path: string; values: Value[] }
  | { op: "valueExists"; path: string }
  | { op: "valueRegex"; path: string; pattern: string }
  | { op: "valueNull"; path: string }
  | { op: "valueMatches"; pattern: Value };

// ---------------------------------------------------------------------------
// Path tokenizer — splits "a.b[0].c" into ["a", "b", "0", "c"]
// ---------------------------------------------------------------------------

function tokenizePath(path: string): string[] {
  // Replace bracket notation [n] with .n then split on dots
  return path.replace(/\[(\d+)\]/g, ".$1").split(".");
}

// ---------------------------------------------------------------------------
// getPath — JSON-path get with dotted/index access (no recursive wildcards)
// ---------------------------------------------------------------------------

export function getPath(value: Value, path: string): Value | undefined {
  const tokens = tokenizePath(path);
  let current: Value = value;
  for (const token of tokens) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return undefined;
      }
      current = current[idx];
    } else {
      if (!(token in current)) {
        return undefined;
      }
      current = (current as Record<string, Value>)[token];
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// structurallyMatches — partial/subset structural match of a pattern against a
// value. For every key in `pattern` (recursively for nested objects), the value
// must have a matching canonicalized value at that location; arrays match
// element-wise by the same rule; primitives match by canonicalizeValue equality.
// Extra keys in the value are allowed.
// ---------------------------------------------------------------------------

function structurallyMatches(value: Value, pattern: Value): boolean {
  // Arrays: match element-wise, lengths must be equal.
  if (Array.isArray(pattern)) {
    if (!Array.isArray(value)) return false;
    if (value.length !== pattern.length) return false;
    return pattern.every((p, i) => structurallyMatches(value[i], p));
  }

  // Objects (non-null, non-array): subset match recursively.
  if (pattern !== null && typeof pattern === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const v = value as Record<string, Value>;
    return Object.keys(pattern).every(
      (key) => key in v && structurallyMatches(v[key], pattern[key])
    );
  }

  // Primitives (and null): canonicalized equality.
  return canonicalizeValue(value) === canonicalizeValue(pattern);
}

// ---------------------------------------------------------------------------
// resolveZodFieldType — walk a Zod schema's shape by dotted path segments
// Returns the ZodType for the final field, or undefined if not found
// ---------------------------------------------------------------------------

function resolveZodFieldType(
  zodSchema: z.ZodTypeAny,
  path: string
): z.ZodTypeAny | undefined {
  const tokens = tokenizePath(path);
  let current: z.ZodTypeAny = zodSchema;

  for (const token of tokens) {
    // Unwrap optional/nullable wrappers to get to the inner type
    current = unwrapZod(current);

    if (current instanceof z.ZodObject) {
      const shape = current.shape as Record<string, z.ZodTypeAny>;
      if (!(token in shape)) {
        return undefined;
      }
      current = shape[token];
    } else if (current instanceof z.ZodArray) {
      // Array index access: descend into the element type
      if (/^\d+$/.test(token)) {
        current = current.element;
      } else {
        return undefined;
      }
    } else {
      // Cannot descend further
      return undefined;
    }
  }

  return current;
}

/** Unwrap ZodOptional / ZodNullable / ZodDefault / ZodBranded to get the inner type */
function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapZod(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapZod(schema.removeDefault());
  }
  if (schema instanceof z.ZodBranded) {
    return unwrapZod(schema.unwrap());
  }
  return schema;
}

/** Returns true if the unwrapped Zod schema is numeric (ZodNumber or ZodInt) */
function isNumericZodType(schema: z.ZodTypeAny): boolean {
  const inner = unwrapZod(schema);
  return inner instanceof z.ZodNumber;
}

/** Returns true if the unwrapped Zod schema is a string type (ZodString) */
function isStringZodType(schema: z.ZodTypeAny): boolean {
  const inner = unwrapZod(schema);
  return inner instanceof z.ZodString;
}

// ---------------------------------------------------------------------------
// typecheckValuePredicate — parse-time type-checking against declared schema
// ---------------------------------------------------------------------------

export function typecheckValuePredicate(
  p: ValuePredicate,
  key: string,
  schema: ClaimSchema
): void {
  if (p.op === "valueMatches") {
    // Structural patterns aren't validated against the field schema —
    // dynamically typed, no-op (no path to check).
    return;
  }

  const zodSchema = schema.valueSchemas?.[key];
  if (zodSchema === undefined) {
    // No declared schema → dynamically typed, no-op
    return;
  }

  // Resolve the field's Zod type by walking the schema along the path
  const fieldType = resolveZodFieldType(zodSchema, p.path);

  if (fieldType === undefined) {
    throw new Error(
      `value predicate path "${p.path}" is not declared in the value schema for key "${key}"`
    );
  }

  const unwrapped = unwrapZod(fieldType);

  if (p.op === "valueExists") {
    // Field exists in schema — that's enough
    return;
  }

  if (p.op === "valueNull") {
    // Field exists in schema (checked above) — that's enough
    return;
  }

  if (p.op === "valueRegex") {
    // Must be a string field
    if (!isStringZodType(fieldType)) {
      throw new Error(
        `valueRegex predicate on path "${p.path}" requires a string field, but the schema declares a non-string type`
      );
    }
    return;
  }

  if (p.op === "valueGt") {
    // Must be a numeric field
    if (!isNumericZodType(fieldType)) {
      throw new Error(
        `valueGt predicate on path "${p.path}" requires a number field, but the schema declares a non-number type`
      );
    }
    return;
  }

  if (p.op === "valueEq") {
    const result = unwrapped.safeParse(p.value);
    if (!result.success) {
      throw new Error(
        `valueEq predicate value ${JSON.stringify(p.value)} is incompatible with the schema for path "${p.path}": ${result.error.message}`
      );
    }
    return;
  }

  if (p.op === "valueIn") {
    for (const v of p.values) {
      const result = unwrapped.safeParse(v);
      if (!result.success) {
        throw new Error(
          `valueIn predicate value ${JSON.stringify(v)} is incompatible with the schema for path "${p.path}": ${result.error.message}`
        );
      }
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// matchesValue — runtime predicate evaluation
// ---------------------------------------------------------------------------

export const matchesValue = (value: Value, p: ValuePredicate): boolean => {
  if (p.op === "valueExists") {
    return getPath(value, p.path) !== undefined;
  }

  if (p.op === "valueEq") {
    const resolved = getPath(value, p.path);
    if (resolved === undefined) return false;
    return canonicalizeValue(resolved) === canonicalizeValue(p.value);
  }

  if (p.op === "valueGt") {
    const resolved = getPath(value, p.path);
    if (resolved === undefined) {
      throw new TypeError(
        `valueGt: path "${p.path}" resolved to undefined — expected a number`
      );
    }
    if (typeof resolved !== "number") {
      throw new TypeError(
        `valueGt: path "${p.path}" resolved to ${JSON.stringify(resolved)} (${typeof resolved}) — expected a number`
      );
    }
    return resolved > p.value;
  }

  if (p.op === "valueIn") {
    const resolved = getPath(value, p.path);
    if (resolved === undefined) return false;
    const canon = canonicalizeValue(resolved);
    return p.values.some((v) => canonicalizeValue(v) === canon);
  }

  if (p.op === "valueRegex") {
    const resolved = getPath(value, p.path);
    if (resolved === undefined) return false;
    if (typeof resolved !== "string") {
      throw new TypeError(
        `valueRegex: path "${p.path}" resolved to ${JSON.stringify(resolved)} (${typeof resolved}) — expected a string`
      );
    }
    return new RegExp(p.pattern).test(resolved);
  }

  if (p.op === "valueNull") {
    return getPath(value, p.path) === null;
  }

  if (p.op === "valueMatches") {
    return structurallyMatches(value, p.pattern);
  }

  // TypeScript exhaustiveness — should never reach here
  const _: never = p;
  throw new Error(`Unknown predicate op: ${JSON.stringify(_)}`);
};
