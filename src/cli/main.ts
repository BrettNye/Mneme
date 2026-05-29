import { parseArgs } from "node:util";
import { openSession, importFile, formatQueryResult } from "../surface/index.js";

const USAGE = `usage: mneme <command> [options]
  corpus create|ls|inspect, commit, query, inspect, replay, import`;

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
      help:       { type: "boolean" },
    },
  });

  const session = openSession({ dbPath: values.db, writer: values.writer });
  const [cmd, sub, ...rest] = positionals;

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

      default:
        console.error(`unknown command: ${cmd ?? "(none)"}\n${USAGE}`);
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
