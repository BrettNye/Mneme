export type Subject = string;
export type Key = string;

const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function subjectOf(key: Key): Subject {
  const segs = key.split(".");
  if (segs.length < 2 || !segs.every((s) => SEGMENT.test(s))) {
    throw new Error(`invalid key "${key}": must be kebab-case dotted {subject}.{domain}[...]`);
  }
  return segs[0];
}
