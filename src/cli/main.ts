import { parseArgs } from "node:util";
import { openSession, importFile, formatQueryResult, explainRecall } from "../surface/index.js";
import { initEmbeddings } from "../surface/embeddings.js";

const USAGE = `usage: mneme <command> [options]
  corpus create|ls|inspect, commit, query, inspect, replay, import, explain <about> [--subject --key --corpus]`;

/** Parse argv, dispatch a subcommand, return a process exit code. */
export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db:         { type: "string" },
      writer:     { type: "string" },
      json:       { type: "boolean" },
      subject:    { type: "string" },
      key:        { type: "string" },
      value:      { type: "string" },
      confidence: { type: "string" },
      as:         { type: "string" },
      batch:      { type: "string" },
      subjects:   { type: "string" },
      corpus:     { type: "string" },
      help:       { type: "boolean" },
    },
  });

  const [cmd, sub, ...rest] = positionals;

  // Handle unknown commands and help BEFORE opening a session.
  if (!cmd || cmd === "help" || cmd === "--help" || values.help) {
    console.error(USAGE);
    return 1;
  }

  const knownCommands = ["query", "import", "corpus", "commit", "inspect", "replay", "explain"];
  if (!knownCommands.includes(cmd)) {
    console.error(`unknown command: ${cmd}\n${USAGE}`);
    return 1;
  }

  // Validate required positionals BEFORE opening a session where possible.
  if (cmd === "query" && !sub) {
    console.error("query requires <corpusId> and a DSL expression");
    return 1;
  }

  if (cmd === "import") {
    if (!sub) {
      console.error("import requires <corpusId>");
      return 1;
    }
    if (!rest[0]) {
      console.error("import requires <file>");
      return 1;
    }
  }

  if (cmd === "commit" && !sub) {
    console.error("commit requires a <corpusId>");
    return 1;
  }

  if (cmd === "inspect" && (!sub || !rest[0])) {
    console.error("inspect requires <corpusId> <claimId>");
    return 1;
  }

  if (cmd === "replay" && (!sub || !rest[0])) {
    console.error("replay requires <corpusId> <claimId>");
    return 1;
  }

  if (cmd === "explain" && !sub) {
    console.error("explain requires <about> (free-text query)");
    return 1;
  }

  // Open the session only for valid commands that need it.
  const session = openSession({ dbPath: values.db, writer: values.writer });

  try {
    switch (cmd) {
      case "query": {
        // sub = corpusId; rest = DSL tokens (may arrive as one quoted arg or several)
        const dsl = rest.join(" ");
        const out = session.q(sub, dsl);
        console.log(values.json ? JSON.stringify(out) : formatQueryResult(out));
        return 0;
      }

      case "import": {
        const stats = await importFile(session, sub, rest[0], {
          format: (values.as ?? "jsonl") as "jsonl" | "conceptnet" | "icews",
          batchSize: values.batch ? Number(values.batch) : undefined,
        });
        console.log(
          `imported ${stats.committed}/${stats.total} in ${stats.elapsedMs}ms` +
          ` (${stats.claimsPerSec}/s; ${stats.rejected} rejected,` +
          ` ${stats.duplicate} dup, ${stats.skipped} skipped)`,
        );
        return 0;
      }

      case "corpus":
        return runCorpus(session, sub, rest, values);

      case "commit": {
        if (!values.subject || !values.key || values.value === undefined) {
          console.error("commit requires --subject, --key, --value");
          return 1;
        }
        const outcome = session.write(sub, {
          subject: values.subject,
          key: values.key,
          value: values.value,
          confidence: values.confidence ? Number(values.confidence) : undefined,
        });
        console.log(`${outcome.id}  ${outcome.status}`);
        return 0;
      }

      case "inspect": {
        const claim = session.inspect(sub, rest[0]);
        console.log(JSON.stringify(claim, null, 2));
        return 0;
      }

      case "replay": {
        const result = session.replay(sub, rest[0]);
        console.log(result.status);
        return 0;
      }

      case "explain": {
        // sub = about; rest joins any trailing tokens into the free-text query.
        const about = [sub, ...rest].join(" ");
        const embeddings = await initEmbeddings();
        const corpus = typeof values.corpus === "string" ? values.corpus : session.listCorpora()[0]?.id;
        if (!corpus) { console.error("no corpus available; pass --corpus <id>"); return 1; }
        const trace = await explainRecall(
          session,
          { about, corpus, subject: values.subject as string | undefined, key: values.key as string | undefined },
          { embeddings },
        );
        if (values.json) { console.log(JSON.stringify(trace)); return 0; }
        const sc = trace.stageCounts;
        console.log(`corpus ${trace.corpus} — ${trace.candidateCount} candidates`);
        console.log(`stages: τ=${sc.afterTau} dedupe=${sc.afterDedupe} ⊥=${sc.afterContradiction} ranked=${sc.ranked} knobs=${sc.afterKnobs} served=${sc.served}`);
        for (const d of trace.claims) {
          const why = d.reason.kind + ("targetId" in d.reason ? `→${d.reason.targetId}` : "byId" in d.reason ? `←${d.reason.byId}` : "");
          console.log(`  [${d.disposition}] ${d.subject} ${d.key} — ${why}${d.score !== undefined ? ` (score ${d.score.toFixed(2)})` : ""}`);
        }
        if (trace.warnings) for (const w of trace.warnings) console.error(`warning: ${w}`);
        return 0;
      }

      default:
        // This branch is unreachable due to the knownCommands check above,
        // but TypeScript requires it for exhaustiveness.
        console.error(`unknown command: ${cmd}\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    console.error((err as Error).message ?? String(err));
    return 1;
  }
}

function runCorpus(
  session: ReturnType<typeof openSession>,
  sub: string,
  rest: string[],
  values: Record<string, string | boolean | undefined>,
): number {
  switch (sub) {
    case "create": {
      const id = rest[0];
      if (!id) {
        console.error("corpus create requires an <id> argument");
        return 1;
      }
      session.createCorpus({
        id,
        subjects: typeof values.subjects === "string"
          ? values.subjects.split(",")
          : undefined,
      });
      console.log(`corpus '${id}' created`);
      return 0;
    }

    case "ls": {
      const corpora = session.listCorpora();
      console.log(corpora.map((c) => `${c.id}  ${c.displayName}`).join("\n"));
      return 0;
    }

    case "inspect": {
      const id = rest[0];
      if (!id) {
        console.error("corpus inspect requires an <id> argument");
        return 1;
      }
      const info = session.inspectCorpus(id);
      console.log(JSON.stringify(info, null, 2));
      return 0;
    }

    default:
      console.error(`unknown corpus subcommand: ${sub ?? "(none)"}\n${USAGE}`);
      return 1;
  }
}
