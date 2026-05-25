export type Instant = number;
export const INFINITY: Instant = Number.POSITIVE_INFINITY;
export interface Interval { from: Instant; to: Instant } // [from, to)
export const covers = (iv: Interval, t: Instant): boolean => iv.from <= t && t < iv.to;
export const now = (): Instant => Date.now();
