// MUST be first import — side-effect-loads last-known synced env vars
// from disk synchronously, so provider SDKs (Anthropic, OpenAI,
// @ai-sdk/google) see ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / etc. at
// their own module-init time. Without this, the SDK constructs at
// import time with empty env (sync only catches up later in middleware).
import "./openscience/preload-env"

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util/log"

import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { SkillCommand } from "./cli/cmd/skill"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@synsci/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { LoginCommand, LogoutCommand, StatusCommand, SyncCommand, DevicesCommand } from "./cli/cmd/connect"
import { ProjectCommand } from "./cli/cmd/project"
import { WalletCommand } from "./cli/cmd/billing"
import { KeysCommand, ConnectCommand, DisconnectCommand } from "./cli/cmd/auth"
import { LocalCommand } from "./cli/cmd/local"
import { InitCommand, DoctorCommand } from "./cli/onboard"
import { OpenScience } from "./openscience"

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("openscience")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    process.env.AGENT = "1"
    process.env.OPENSCIENCE = "1"

    Log.Default.info("openscience", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })

    // Cheap /sync/version probe (10s TTL). When the server-side version
    // has changed, a full /api/cli/sync runs in the background so the new
    // env applies to the NEXT command — the current one uses whatever is
    // already cached on disk. Replaces a blocking 5s Promise.race that
    // ran on every invocation regardless of staleness.
    await OpenScience.refreshIfStale().catch(() => {})

    // Inject decrypted service credentials (settings ▸ Credentials) into the
    // process env so skills/tools/connectors actually use them. Dynamic import
    // keeps the credential route module out of every command's static graph.
    await import("./server/routes/settings/credentials").then((m) => m.applyCredentialEnv()).catch(() => {})

    // Same for BYOK GPU provider keys (settings ▸ Compute) — decrypt and inject
    // under the canonical env var names the compute skills read.
    await import("./server/routes/settings/compute").then((m) => m.ComputeSettings.applyComputeEnv()).catch(() => {})

    // Retry any failed usage reports from previous sessions
    OpenScience.flushPendingUsage().catch(() => {})
  })
  .usage("\n" + UI.logo())
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)

  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(LocalCommand)
  .command(SkillCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(InitCommand)
  .command(LoginCommand)
  .command(LogoutCommand)
  .command(StatusCommand)
  .command(SyncCommand)
  .command(DevicesCommand)
  .command(KeysCommand)
  .command(WalletCommand)
  .command(DoctorCommand)
  .command(ProjectCommand)
  .command(ConnectCommand)
  .command(DisconnectCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp("log")
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  await cli.parse()
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e instanceof Error ? e.message : String(e))
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
