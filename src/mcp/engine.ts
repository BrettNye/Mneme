/**
 * Shared engine bootstrap: the loadMnemeConfig + openSession sequence that both
 * the MCP server and any embedding plugin need. Extracted for DRY reuse — a
 * single reusable path so bootstrap logic (db path resolution, per-repo corpus
 * default, config loading) lives in exactly one place.
 */
import { basename } from "node:path";
import { openSession } from "../surface/index.js";
import type { Session } from "../surface/types.js";
import { loadMnemeConfig } from "./config.js";
import { initEmbeddings } from "../surface/embeddings.js";

export interface OpenEngineOptions {
  dbPath?: string;
  corpus?: string;
  /** Provenance writer id for session writes. Defaults to "mcp". */
  writer?: string;
}

export interface MnemeEngine {
  session: Session;
  dbPath: string;
  defaultCorpus: string;
  keyCardinality: ReturnType<typeof loadMnemeConfig>["keyCardinality"];
  /** Memoized lazy embedding loader — NOT called here; first recall pays the cost. */
  initEmbeddings: typeof initEmbeddings;
}

export function openMnemeEngine(opts: OpenEngineOptions = {}): MnemeEngine {
  const dbPath = opts.dbPath ?? process.env.MNEME_DB ?? "./.mneme/store.db";
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const defaultCorpus =
    opts.corpus ?? process.env.MNEME_CORPUS ?? (basename(projectDir) || "default");
  const config = loadMnemeConfig(dbPath); // throws on bad config — intentionally unwrapped
  const session = openSession({ dbPath, writer: opts.writer ?? "mcp" });
  return { session, dbPath, defaultCorpus, keyCardinality: config.keyCardinality, initEmbeddings };
}
