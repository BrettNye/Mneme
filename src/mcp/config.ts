import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MnemeConfig {
  keyCardinality?: Record<string, "single" | "multi">;
}

const KNOWN_KEYS = new Set(["keyCardinality"]);
const VALID_CARDINALITY = new Set(["single", "multi"]);

/**
 * Load `config.json` from the same directory as `dbPath`.
 *
 * - dbPath `./.mneme/store.db` => `./.mneme/config.json`
 * - Absent file => `{}`
 * - Malformed JSON => throws, naming the path
 * - Invalid cardinality value => throws, naming key + value
 * - Unknown top-level keys => `console.warn`, dropped
 */
export function loadMnemeConfig(dbPath: string): MnemeConfig {
  const configPath = join(dirname(dbPath), "config.json");

  if (!existsSync(configPath)) {
    return {};
  }

  let raw: string;
  raw = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Mneme config at ${configPath} contains malformed JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Mneme config at ${configPath} must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;
  const result: MnemeConfig = {};

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      console.warn(`Mneme config: unknown top-level key "${key}" — ignored`);
      continue;
    }

    if (key === "keyCardinality") {
      const cardinality = obj[key];
      if (typeof cardinality !== "object" || cardinality === null || Array.isArray(cardinality)) {
        throw new Error(
          `Mneme config: keyCardinality must be a plain object, got ${typeof cardinality}`
        );
      }
      const cardMap = cardinality as Record<string, unknown>;
      const validated: Record<string, "single" | "multi"> = {};
      for (const [k, v] of Object.entries(cardMap)) {
        if (!VALID_CARDINALITY.has(v as string)) {
          throw new Error(
            `Mneme config: keyCardinality["${k}"] has invalid value "${v}" — must be "single" or "multi"`
          );
        }
        validated[k] = v as "single" | "multi";
      }
      result.keyCardinality = validated;
    }
  }

  return result;
}
