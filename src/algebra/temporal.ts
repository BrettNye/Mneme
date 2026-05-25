import type { Corpus } from "./types.js";
import { filterCorpus } from "./types.js";
import { covers, now, type Instant } from "../core/time.js";

export const tauValid =
  (t: Instant) =>
  (c: Corpus): Corpus =>
    filterCorpus(c, (cl) => covers(cl.valid, t));

export const tauRecorded =
  (t: Instant) =>
  (c: Corpus): Corpus =>
    filterCorpus(c, (cl) => cl.recorded <= t);

export const tauKnown =
  (t: Instant) =>
  (c: Corpus): Corpus =>
    tauValid(t)(tauRecorded(t)(c));

export const tauNow =
  (clock: () => Instant = now) =>
  (c: Corpus): Corpus =>
    tauKnown(clock())(c);
