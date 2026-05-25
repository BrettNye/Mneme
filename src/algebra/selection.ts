import type { Corpus } from "./types.js";
import { filterCorpus } from "./types.js";
import { matches, type Predicate } from "./predicate.js";

export const sigma = (p: Predicate) => (c: Corpus): Corpus =>
  filterCorpus(c, (cl) => matches(cl, p));
