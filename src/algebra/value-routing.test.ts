import { describe, it, expect, vi } from "vitest";
import {
  collectValuePredicates,
  routeValuePredicates,
  UnsupportedValuePredicateError,
  type QueryWarning,
} from "./value-routing.js";
import type { Predicate } from "./predicate.js";
import type { AdapterCapabilities } from "../adapters/adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capsWithLevel(
  kind: keyof AdapterCapabilities["valuePredicateSupport"],
  level: AdapterCapabilities["valuePredicateSupport"][typeof kind]
): AdapterCapabilities {
  return {
    valuePredicateSupport: {
      equality: "native_indexed",
      range: "native_indexed",
      set_membership: "native_indexed",
      regex: "native_indexed",
      structural_pattern: "native_indexed",
      null_check: "native_indexed",
      [kind]: level,
    },
  };
}

const defaultCaps: AdapterCapabilities = capsWithLevel("equality", "native_indexed");

// ---------------------------------------------------------------------------
// collectValuePredicates
// ---------------------------------------------------------------------------

describe("collectValuePredicates", () => {
  it("returns empty array for a non-value predicate", () => {
    const p: Predicate = { op: "subjectEq", value: "x" };
    expect(collectValuePredicates(p)).toEqual([]);
  });

  it("returns itself wrapped in array for a bare value predicate", () => {
    const p: Predicate = { op: "valueEq", path: "a", value: 1 };
    const result = collectValuePredicates(p);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(p);
  });

  it("collects value predicates nested inside 'and'", () => {
    const vp1: Predicate = { op: "valueEq", path: "a", value: 1 };
    const vp2: Predicate = { op: "valueGt", path: "b", value: 5 };
    const p: Predicate = { op: "and", preds: [{ op: "subjectEq", value: "x" }, vp1, vp2] };
    const result = collectValuePredicates(p);
    expect(result).toHaveLength(2);
    expect(result).toContain(vp1);
    expect(result).toContain(vp2);
  });

  it("collects value predicates nested inside 'or'", () => {
    const vp: Predicate = { op: "valueIn", path: "c", values: ["x", "y"] };
    const p: Predicate = { op: "or", preds: [vp, { op: "keyEq", value: "k" }] };
    const result = collectValuePredicates(p);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(vp);
  });

  it("collects value predicates nested inside 'not'", () => {
    const vp: Predicate = { op: "valueNull", path: "x" };
    const p: Predicate = { op: "not", pred: vp };
    const result = collectValuePredicates(p);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(vp);
  });

  it("handles deeply nested and/or/not combinations", () => {
    const vp1: Predicate = { op: "valueRegex", path: "name", pattern: "foo" };
    const vp2: Predicate = { op: "valueExists", path: "count" };
    const p: Predicate = {
      op: "and",
      preds: [
        { op: "not", pred: vp1 },
        { op: "or", preds: [vp2, { op: "statusEq", value: "active" }] },
      ],
    };
    const result = collectValuePredicates(p);
    expect(result).toHaveLength(2);
    expect(result).toContain(vp1);
    expect(result).toContain(vp2);
  });
});

// ---------------------------------------------------------------------------
// routeValuePredicates — unsupported → throws
// ---------------------------------------------------------------------------

describe("routeValuePredicates — unsupported kind throws", () => {
  it("throws UnsupportedValuePredicateError on an unsupported kind", () => {
    const caps = capsWithLevel("regex", "unsupported");
    expect(() =>
      routeValuePredicates(
        { op: "valueRegex", path: "x", pattern: "a" },
        caps,
        { workingSetSize: 1, threshold: 0, onWarning: () => {} }
      )
    ).toThrow(UnsupportedValuePredicateError);
  });

  it("error includes the predicate kind in the message", () => {
    const caps = capsWithLevel("regex", "unsupported");
    let err: unknown;
    try {
      routeValuePredicates(
        { op: "valueRegex", path: "p", pattern: "a" },
        caps,
        { workingSetSize: 0, threshold: 0, onWarning: () => {} }
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedValuePredicateError);
    expect((err as UnsupportedValuePredicateError).predicateKind).toBe("regex");
    expect((err as UnsupportedValuePredicateError).message).toContain("regex");
  });

  it("error includes the path when present", () => {
    const caps = capsWithLevel("equality", "unsupported");
    let err: unknown;
    try {
      routeValuePredicates(
        { op: "valueEq", path: "meta.score", value: 42 },
        caps,
        { workingSetSize: 0, threshold: 0, onWarning: () => {} }
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedValuePredicateError);
    expect((err as UnsupportedValuePredicateError).path).toBe("meta.score");
    expect((err as UnsupportedValuePredicateError).message).toContain("meta.score");
  });

  it("valueMatches (no path) sets path to undefined on the error", () => {
    const caps = capsWithLevel("structural_pattern", "unsupported");
    let err: unknown;
    try {
      routeValuePredicates(
        { op: "valueMatches", pattern: { a: 1 } },
        caps,
        { workingSetSize: 0, threshold: 0, onWarning: () => {} }
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedValuePredicateError);
    expect((err as UnsupportedValuePredicateError).path).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// routeValuePredicates — fallback_in_memory + threshold
// ---------------------------------------------------------------------------

describe("routeValuePredicates — fallback_in_memory warnings", () => {
  it("calls onWarning when workingSetSize > threshold", () => {
    const caps = capsWithLevel("regex", "fallback_in_memory");
    const warnings: QueryWarning[] = [];
    routeValuePredicates(
      { op: "valueRegex", path: "name", pattern: "foo" },
      caps,
      { workingSetSize: 100, threshold: 10, onWarning: (w) => warnings.push(w) }
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("fallback_in_memory");
    expect(warnings[0].predicateKind).toBe("regex");
    expect(warnings[0].workingSetSize).toBe(100);
    expect(warnings[0].threshold).toBe(10);
  });

  it("includes path in the warning when present", () => {
    const caps = capsWithLevel("regex", "fallback_in_memory");
    const warnings: QueryWarning[] = [];
    routeValuePredicates(
      { op: "valueRegex", path: "title", pattern: "bar" },
      caps,
      { workingSetSize: 50, threshold: 5, onWarning: (w) => warnings.push(w) }
    );
    expect(warnings[0].path).toBe("title");
  });

  it("does NOT call onWarning when workingSetSize === threshold (at threshold)", () => {
    const caps = capsWithLevel("regex", "fallback_in_memory");
    const onWarning = vi.fn();
    routeValuePredicates(
      { op: "valueRegex", path: "x", pattern: "." },
      caps,
      { workingSetSize: 10, threshold: 10, onWarning }
    );
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("does NOT call onWarning when workingSetSize < threshold", () => {
    const caps = capsWithLevel("regex", "fallback_in_memory");
    const onWarning = vi.fn();
    routeValuePredicates(
      { op: "valueRegex", path: "x", pattern: "." },
      caps,
      { workingSetSize: 5, threshold: 10, onWarning }
    );
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("warning message describes the fallback situation", () => {
    const caps = capsWithLevel("regex", "fallback_in_memory");
    const warnings: QueryWarning[] = [];
    routeValuePredicates(
      { op: "valueRegex", path: "x", pattern: "." },
      caps,
      { workingSetSize: 200, threshold: 100, onWarning: (w) => warnings.push(w) }
    );
    expect(warnings[0].message).toContain("regex");
    expect(warnings[0].message).toContain("200");
  });

  it("fires one warning per fallback predicate in a compound predicate", () => {
    const caps: AdapterCapabilities = {
      valuePredicateSupport: {
        equality: "native_indexed",
        range: "native_indexed",
        set_membership: "native_indexed",
        regex: "fallback_in_memory",
        structural_pattern: "fallback_in_memory",
        null_check: "native_indexed",
      },
    };
    const warnings: QueryWarning[] = [];
    const p: Predicate = {
      op: "and",
      preds: [
        { op: "valueRegex", path: "a", pattern: "x" },
        { op: "valueMatches", pattern: { b: 2 } },
      ],
    };
    routeValuePredicates(p, caps, {
      workingSetSize: 500,
      threshold: 100,
      onWarning: (w) => warnings.push(w),
    });
    expect(warnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// routeValuePredicates — native kinds → no throw, no warning
// ---------------------------------------------------------------------------

describe("routeValuePredicates — native kinds are silent", () => {
  it("native_indexed kind does not throw or warn", () => {
    const onWarning = vi.fn();
    expect(() =>
      routeValuePredicates(
        { op: "valueEq", path: "x", value: 1 },
        defaultCaps,
        { workingSetSize: 999999, threshold: 0, onWarning }
      )
    ).not.toThrow();
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("native_unindexed kind does not throw or warn", () => {
    const caps = capsWithLevel("range", "native_unindexed");
    const onWarning = vi.fn();
    expect(() =>
      routeValuePredicates(
        { op: "valueGt", path: "score", value: 5 },
        caps,
        { workingSetSize: 999999, threshold: 0, onWarning }
      )
    ).not.toThrow();
    expect(onWarning).not.toHaveBeenCalled();
  });
});
