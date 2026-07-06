import type { CandidateClaim, Source } from "../index.js";
import { scalarConfidence } from "../core/confidence.js";
import { SURFACE_DEFAULTS, defaultConfidence } from "./types.js";
import type { WriteRecord } from "./types.js";

/** Per-write shaping context: corpus identity, schema version, and the
 *  session-level defaults (profile/workspace/source) a WriteRecord may omit. */
export interface CandidateContext {
  corpusId: string;
  /** Resolver rule: `def.schema.version ?? SURFACE_DEFAULTS.schemaVersion` (B5) —
   *  callers pass the already-resolved version, this function does not re-resolve it. */
  schemaVersion: string;
  profile?: string;
  workspace?: string;
  source?: Source;
}

/** Pure WriteRecord→CandidateClaim shaping — the ONE home for this expansion.
 *  session.write/writeMany and test-support's spy-session both delegate here. */
export function buildCandidateClaim(rec: WriteRecord, ctx: CandidateContext): CandidateClaim {
  return {
    profile: (ctx.profile ?? SURFACE_DEFAULTS.profile) as never,
    workspace: (ctx.workspace ?? ctx.corpusId) as never,
    subject: rec.subject as never,
    key: rec.key as never,
    scope: rec.scope ?? {},
    value: rec.value,
    confidence:
      rec.confidence == null
        ? defaultConfidence()
        : typeof rec.confidence === "number"
          ? scalarConfidence(rec.confidence)
          : rec.confidence,
    valid: rec.valid ?? SURFACE_DEFAULTS.validInterval,
    source: rec.source ?? ctx.source ?? SURFACE_DEFAULTS.source,
    provenance: {},
    evidence: [],
    tags: rec.tags ?? [],
    schema: `${ctx.corpusId}@${ctx.schemaVersion}`,
    status: rec.status,
  };
}
