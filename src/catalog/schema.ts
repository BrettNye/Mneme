import { z } from "zod";
import type { Source } from "../core/claim.js";
import type { Scope } from "../core/scope.js";

export interface ClaimSchema {
  version: string;
  subjects: string[];
  /** Declared scope fields and their types (strict: undeclared fields are rejected). */
  scopeFields: Record<string, "string">;
  /** Optional Zod schema per value key for type-checking. */
  valueSchemas?: Record<string, z.ZodTypeAny>;
  required: string[];
  /** Required pseudocount per source — no silent defaults (§3.2 MUST). */
  scalarPseudocount: Partial<Record<Source, number>>;
  /** Per-key cardinality; undeclared keys are "single" (⊥ eligible). */
  keyCardinality?: Record<string, "single" | "multi">;
}

/**
 * Validates that all fields present in `scope` are declared in `schema.scopeFields`.
 * Throws if any undeclared field is encountered (strict scope).
 */
export function validateScope(scope: Scope, schema: ClaimSchema): void {
  for (const field of Object.keys(scope)) {
    if (scope[field] !== undefined && !(field in schema.scopeFields)) {
      throw new Error(
        `scope field "${field}" is not declared in the corpus schema (strict scope)`
      );
    }
  }
}

/**
 * Returns the declared pseudocount for `source`.
 * Throws if no entry is declared — no silent default (§3.2 MUST).
 */
export function pseudocountFor(source: Source, schema: ClaimSchema): number {
  const pc = schema.scalarPseudocount[source];
  if (pc === undefined) {
    throw new Error(
      `no scalarPseudocount declared for source "${source}" (required, no default)`
    );
  }
  return pc;
}

/**
 * Returns the Zod schema declared for `key` in `schema.valueSchemas`, or
 * `undefined` if none is declared.  Callers can use this for write-time type
 * checking against declared value predicates.
 */
export function getValueSchema(
  key: string,
  schema: ClaimSchema
): z.ZodTypeAny | undefined {
  return schema.valueSchemas?.[key];
}

/**
 * Returns the cardinality ("single" | "multi") for `key` from the supplied map.
 * Undeclared keys default to "single". Throws on values outside "single"|"multi"
 * (manual strict check mirroring validateScope — no zod, per design audit A3).
 */
export function cardinalityOf(
  key: string,
  map?: Record<string, "single" | "multi">,
): "single" | "multi" {
  const v = map?.[key];
  if (v === undefined) return "single";
  if (v !== "single" && v !== "multi") {
    throw new Error(
      `invalid keyCardinality "${v}" for key "${key}" (expected "single" | "multi")`,
    );
  }
  return v;
}
