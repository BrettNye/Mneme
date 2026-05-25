import type { Corpus } from "./types.js";
import { corpusOf } from "./types.js";
import type { Claim } from "../core/claim.js";

export type Field = keyof Claim;

export const pi =
  (fields: Field[]) =>
  (c: Corpus): Corpus =>
    corpusOf(
      c.claims.map((cl) => {
        const out: Partial<Claim> = {};
        for (const f of fields) (out as any)[f] = cl[f];
        return out as Claim;
      }),
    );
