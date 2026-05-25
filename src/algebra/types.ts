import type { Claim } from "../core/claim.js";

export interface Corpus {
  readonly claims: readonly Claim[];
}

export interface ScoredClaim {
  readonly claim: Claim;
  readonly score: number;
}

export interface RankedCorpus {
  readonly scored: readonly ScoredClaim[];
}

export interface ComposedContext {
  readonly format: "xml" | "markdown" | "json" | "text";
  readonly content: string;
  readonly tokenCount: number;
}

export const corpusOf = (claims: Claim[]): Corpus => ({
  claims: Object.freeze([...claims]),
});

export const mapCorpus = (c: Corpus, f: (cl: Claim) => Claim): Corpus =>
  corpusOf(c.claims.map(f));

export const filterCorpus = (c: Corpus, p: (cl: Claim) => boolean): Corpus =>
  corpusOf(c.claims.filter(p));
