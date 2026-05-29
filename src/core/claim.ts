import type { ClaimId, ProfileId, WorkspaceId } from "./ids.js";
import type { Value } from "./value.js";
import type { Interval, Instant } from "./time.js";
import type { Subject, Key } from "./key.js";
import type { Scope } from "./scope.js";
import type { Confidence } from "./confidence.js";
import type { EvidenceRef } from "./evidence.js";
import type { Provenance } from "./provenance.js";
import type { Audience } from "./audience.js";

export type Status = "candidate" | "provisional" | "validated" | "deprecated";
export type Source = "manual" | "verification" | "workflow" | "heuristic" | "llm" | "imported";

export interface Claim {
  id: ClaimId;
  profile: ProfileId;
  workspace: WorkspaceId;
  subject: Subject;
  key: Key;
  scope: Scope;
  scopeHash: string;
  value: Value;
  valueHash: string;
  confidence: Confidence;
  valid: Interval;
  recorded: Instant;
  recordedSeq: number;
  status: Status;
  source: Source;
  provenance: Provenance;
  evidence: EvidenceRef[];
  audience: Audience;
  tags: string[];
  schema: string;
}

export type CandidateClaim =
  Omit<Claim, "id" | "recorded" | "recordedSeq" | "scopeHash" | "valueHash" | "status" | "audience">
  & { status?: Status; audience?: Audience };
