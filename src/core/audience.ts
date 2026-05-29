/**
 * Audience — persona-targeting hints carried by a claim (§2.1).
 *
 * Hints only: they record who a claim is intended for. Audience-based read
 * filtering is part of the access-control surface (§9), which is deferred — so
 * v0.2 records audience but does not yet enforce it. An absent/empty Audience
 * means "no targeting hint".
 */
export interface Audience {
  /** Persona ids this claim is targeted at. */
  personas?: string[];
}
