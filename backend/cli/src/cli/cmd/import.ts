import type { Argv } from "yargs"
import { Session } from "../../session"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Storage } from "../../storage/storage"
import { Instance } from "../../project/instance"
import { EOL } from "os"
import * as prompts from "@clack/prompts"
import { ForeignImport } from "../../session/foreign/import"
import type { ForeignSource } from "../../session/foreign/types"

export type SessionExport = {
  info: Session.Info
  messages: Array<{
    info: any
    parts: any[]
  }>
}

/** Read an exported session file, saying which of the two failures it was.
 * A single `json().catch(() => {})` reported a malformed file as missing, and
 * the second copy of the same check below was unreachable. */
export async function readExport(
  file: string,
): Promise<{ ok: true; data: SessionExport } | { ok: false; message: string }> {
  if (!(await Bun.file(file).exists())) return { ok: false, message: `File not found: ${file}` }
  let data: unknown
  try {
    data = await Bun.file(file).json()
  } catch (error) {
    return {
      ok: false,
      message: `Failed to read session data from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (typeof data !== "object" || data === null || !("info" in data) || !("messages" in data)) {
    return { ok: false, message: `Failed to read session data from ${file}: expected an object with info and messages` }
  }
  return { ok: true, data: data as SessionExport }
}

const OUTCOME: Record<string, string> = {
  created: "New session created.",
  updated: "Added the new messages to the existing session.",
  "copied:continued": "Your earlier import has been continued in OpenScience, so this is a separate copy.",
  "copied:rewound": "The conversation was rewound or edited since the last import, so this is a separate copy.",
  unchanged: "Nothing new to import; the existing session is up to date.",
}

function fail(message: string) {
  process.stderr.write(message)
  process.stderr.write(EOL)
  process.exitCode = 1
}

const NAMES: Record<ForeignSource, string> = { claude: "Claude Code", codex: "Codex" }

async function importForeign(source: ForeignSource, id: string | undefined, access: string | undefined) {
  const interactive = process.stdin.isTTY && process.stdout.isTTY
  let sourceID = id
  if (!sourceID) {
    if (!interactive) return fail(`Give the ${NAMES[source]} session id to import.`)
    const sessions = await ForeignImport.list(source)
    if (!sessions.length) return fail(`No ${NAMES[source]} sessions found.`)
    const picked = await prompts.autocomplete({
      message: `Import a ${NAMES[source]} session`,
      maxItems: 10,
      options: sessions.map((session) => ({
        value: session.id,
        label: [
          new Date(session.modified).toLocaleString(),
          session.cwd ?? "",
          (session.title ?? session.firstMessage ?? "").replace(/\s+/g, " ").slice(0, 60),
        ]
          .filter(Boolean)
          .join("  "),
      })),
    })
    if (prompts.isCancel(picked)) return fail("Import cancelled.")
    sourceID = picked as string
  }

  let folderAccess = access
  if (!folderAccess) {
    const folder = await ForeignImport.folder(source, sourceID).catch(() => undefined)
    if (interactive && folder?.exists && folder.path) {
      const picked = await prompts.select({
        message: `Connect ${folder.path}?`,
        initialValue: "write",
        options: [
          { value: "write", label: "Read and write" },
          { value: "read", label: "Read only" },
          { value: "none", label: "Don't connect" },
        ],
      })
      if (prompts.isCancel(picked)) return fail("Import cancelled.")
      folderAccess = picked as string
    } else {
      // Nobody was asked, so nothing is connected: a script must pass --folder-access.
      folderAccess = "none"
      if (folder?.exists && folder.path && !folder.connected) {
        process.stdout.write(
          `Folder not connected: ${folder.path} (pass --folder-access write or read to connect it)` + EOL,
        )
      }
    }
  }
  const parsed = ForeignImport.FolderAccess.safeParse(folderAccess)
  if (!parsed.success) return fail("--folder-access must be write, read or none.")

  try {
    const result = await ForeignImport.run({ source, sourceID, folderAccess: parsed.data })
    process.stdout.write(`Imported session: ${result.sessionID}` + EOL)
    const key = result.outcome === "copied" ? `copied:${result.reason}` : result.outcome
    process.stdout.write((OUTCOME[key] ?? result.outcome) + EOL)
    if (result.folderMissing) {
      process.stdout.write("The original folder is not available, so the session uses the normal workspace." + EOL)
    }
  } catch (error) {
    if (ForeignImport.NotFoundError.isInstance(error)) return fail(`Session not found: ${sourceID}`)
    fail(error instanceof Error ? error.message : String(error))
  }
}

export const ImportCommand = cmd({
  command: "import [file]",
  describe: "import a session from a JSON export, or a Claude Code or Codex conversation",
  builder: (yargs: Argv) => {
    return yargs
      .positional("file", {
        describe: "path to JSON file",
        type: "string",
      })
      .option("from-claude", {
        describe: "import a Claude Code conversation (session id, or pick one)",
        type: "string",
      })
      .option("from-codex", {
        describe: "import a Codex conversation (session id, or pick one)",
        type: "string",
      })
      .option("folder-access", {
        describe: "connect the conversation's folder: write, read or none",
        type: "string",
        choices: ["write", "read", "none"],
      })
  },
  handler: async (args) => {
    const fromClaude = args.fromClaude as string | undefined
    const fromCodex = args.fromCodex as string | undefined
    const foreign = fromClaude !== undefined || fromCodex !== undefined
    if (foreign && (args.file || (fromClaude !== undefined && fromCodex !== undefined))) {
      return fail("Import either a file or one of --from-claude / --from-codex, not both.")
    }
    if (!foreign && !args.file) return fail("Give a JSON export file, or --from-claude / --from-codex.")
    await bootstrap(process.cwd(), async () => {
      if (foreign) {
        const source: ForeignSource = fromClaude !== undefined ? "claude" : "codex"
        const id = (source === "claude" ? fromClaude : fromCodex) || undefined
        return importForeign(source, id, args.folderAccess as string | undefined)
      }
      const read = await readExport(args.file!)
      if (!read.ok) {
        // A failure here is the whole result of the command, so it must not
        // exit 0 and read as a success in a script.
        process.stderr.write(read.message)
        process.stderr.write(EOL)
        process.exitCode = 1
        return
      }
      const exportData = read.data

      await Storage.write(["session", Instance.project.id, exportData.info.id], exportData.info)

      for (const msg of exportData.messages) {
        await Storage.write(["message", exportData.info.id, msg.info.id], msg.info)

        for (const part of msg.parts) {
          await Storage.write(["part", msg.info.id, part.id], part)
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
