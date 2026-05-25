import type { RankedCorpus, ComposedContext } from "./types.js";
import { simJaccard } from "./similarity.js";

export type TokenCounter = (s: string) => number;

export const defaultCounter: TokenCounter = (s) => Math.ceil(s.length / 4);

// δ_dedup_content: remove near-duplicate claims above the Jaccard threshold
export const dedupContent =
  (threshold: number) =>
  (rc: RankedCorpus): RankedCorpus => {
    const kept: typeof rc.scored[number][] = [];
    for (const s of rc.scored) {
      if (!kept.some((k) => simJaccard.scoreOne(k.claim.value, s.claim.value) >= threshold)) {
        kept.push(s);
      }
    }
    return { scored: kept };
  };

export type Format = "xml" | "markdown" | "json" | "text";

const escXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// φ_format: render a RankedCorpus into a ComposedContext
export const format =
  (fmt: Format) =>
  (rc: RankedCorpus): ComposedContext => {
    let content: string;

    switch (fmt) {
      case "xml": {
        const body = rc.scored
          .map((s) => `<claim score="${s.score}">${escXml(String(s.claim.value))}</claim>`)
          .join("\n");
        content = `<context>\n${body}\n</context>`;
        break;
      }
      case "markdown": {
        content = rc.scored.map((s) => `- ${String(s.claim.value)}`).join("\n");
        break;
      }
      case "json": {
        content = JSON.stringify(
          rc.scored.map((s) => ({ value: s.claim.value, score: s.score }))
        );
        break;
      }
      case "text": {
        content = rc.scored.map((s) => String(s.claim.value)).join("\n");
        break;
      }
    }

    return { format: fmt, content, tokenCount: defaultCounter(content) };
  };

// β_budget: truncate content to stay within the token budget
export const budget =
  (max: number, count: TokenCounter = defaultCounter) =>
  (cc: ComposedContext): ComposedContext => {
    if (count(cc.content) <= max) return cc;
    let sliced = cc.content.slice(0, max * 4);
    while (sliced.length > 0 && count(sliced) > max) {
      sliced = sliced.slice(0, Math.floor(sliced.length * 0.9));
    }
    return { ...cc, content: sliced, tokenCount: count(sliced) };
  };

// κ = β_budget ∘ φ_format ∘ δ_dedup_content
export const kappa =
  (fmt: Format, maxTokens: number, dedupThreshold = 0.9) =>
  (rc: RankedCorpus): ComposedContext =>
    budget(maxTokens)(format(fmt)(dedupContent(dedupThreshold)(rc)));
