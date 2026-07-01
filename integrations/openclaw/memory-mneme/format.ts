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
