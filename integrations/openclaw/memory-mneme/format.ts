const OPEN = "<relevant-memories>";
const CLOSE = "</relevant-memories>";

/** Wrap mneme's ComposedContext for context injection. Blank content → "" (no envelope). */
export function wrapMemories(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return `${OPEN}\n${trimmed}\n${CLOSE}`;
}

/** Overlay a per-write scope on the configured default (write keys win). */
export function mergeScope(
  defaultScope: Record<string, string> | undefined,
  scope: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!defaultScope && !scope) return undefined;
  return { ...(defaultScope ?? {}), ...(scope ?? {}) };
}

/** Agent-in-the-loop honesty annotation: entity-coverage gaps from recall().coverage.missing.
 *  Empty missing → "". Caps the list to keep the note terse. */
export function coverageNote(missing: string[] | undefined, max = 5): string {
  if (!missing?.length) return "";
  const shown = missing.slice(0, max);
  const more = missing.length > max ? ` (+${missing.length - max} more)` : "";
  return `\n\n⚠ No stored claims mention: ${shown.join(", ")}${more}.`;
}

/** Provenance footer: claim ids so the agent can cite/reference exact claims.
 *  Empty matches → "". */
export function provenanceFooter(
  matches: { id: string; subject: string; key: string }[] | undefined,
): string {
  if (!matches?.length) return "";
  const lines = matches.map((m) => `- ${m.id} (${m.subject} ${m.key})`).join("\n");
  return `\n\nsources:\n${lines}`;
}
