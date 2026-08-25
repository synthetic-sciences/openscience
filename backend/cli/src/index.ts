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
import { SandboxCommand } from "./cli/cmd/sandbox"
import { InitCommand, DoctorCommand } from "./cli/onboard"
import { OpenScience } from "./openscience"
import { GROUP_LAUNCHER_ARG, run as runMcpGroupLauncher } from "./mcp/group-launcher"
import { WINDOWS_JOB_LAUNCHER_ARG, WindowsJobLauncher } from "./process/windows-job-launcher"
import {
  DARWIN_RESPONSIBILITY_LAUNCHER_ARG,
  DarwinResponsibilityLauncher,
} from "./process/darwin-responsibility-launcher"
import { Global } from "./global"
import { disposeDataRootOperation, runDataRootMiddleware } from "./cli/cmd/cmd"
import { ACCOUNT_REQUIRED_MESSAGE, requiresOpenScienceAccount } from "./cli/account-gate"
import { OutboundTelemetry } from "./telemetry/outbound"
import { purgeRetiredAtlasAgentInstall } from "./skill/retired-install"

if (process.argv[2] === WINDOWS_JOB_LAUNCHER_ARG) {
  try {
    process.exit(await WindowsJobLauncher.run(process.argv.slice(3)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

if (process.argv[2] === DARWIN_RESPONSIBILITY_LAUNCHER_ARG) {
  try {
    process.exit(await DarwinResponsibilityLauncher.run(process.argv.slice(3)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

if (process.argv[2] === GROUP_LAUNCHER_ARG) {
  try {
    process.exit(await runMcpGroupLauncher(process.argv.slice(3)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

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

// Yargs handles --help/--version before middleware. Run the exact, fail-safe
// retirement migration here so the first post-upgrade invocation cleans old
// agent instructions even when it exits through those built-in paths. Internal
// process launchers return above and never touch user configuration.
let retiredAgentInstallCleanupError: unknown
await purgeRetiredAtlasAgentInstall(Global.Path.home).catch((error) => {
  retiredAgentInstallCleanupError = error
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
    const initialize = async () => {
      await Log.init({
        print: process.argv.includes("--print-logs"),
        dev: Installation.isLocal(),
        level: (() => {
          if (opts.logLevel) return opts.logLevel as Log.Level
          if (Installation.isLocal()) return "DEBUG"
          return "INFO"
        })(),
      })
      OpenScience.reportApiBaseOverride()

      process.env.AGENT = "1"
      process.env.OPENSCIENCE = "1"

      Log.Default.info("openscience", {
        version: Installation.VERSION,
        args: process.argv.slice(2),
      })

      if (retiredAgentInstallCleanupError) {
        Log.Default.warn("failed to purge retired Atlas agent install", { error: retiredAgentInstallCleanupError })
      }

      // A consent change may have been saved while offline. Retry it on every
      // startup before the account gate can exit. Opt-out is prospective and
      // never turns into an implicit deletion request.
      await OutboundTelemetry.initializeAccount().catch(() => undefined)

      if (requiresOpenScienceAccount(command, process.argv.slice(2)) && !(await OpenScience.isAuthenticated())) {
        throw new Error(ACCOUNT_REQUIRED_MESSAGE)
      }

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

      // Legacy skill-based compute providers still consume their enabled keys
      // from subprocess environments. Modal remains adapter-only.
      await import("./server/routes/settings/compute").then((m) => m.ComputeSettings.applyComputeEnv()).catch(() => {})

      // First authenticated startup quietly provisions the app-owned Python
      // and R starters. The command does not wait for package resolution; the
      // first kernel request joins the same lease-backed setup if it is still
      // running. OpenScience never modifies the user's Python, R, or Conda.
      await import("./science/kernel/environment-manager")
        .then((m) => m.ManagedEnvironments.startInBackground())
        .catch(() => {})

      // Retry any failed usage reports from previous sessions
      OpenScience.flushPendingUsage().catch(() => {})
    }

    const command = typeof opts._[0] === "string" ? opts._[0] : undefined
    return await runDataRootMiddleware(command, Global.Path.data, initialize)
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
  .command(SandboxCommand)
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

async function run() {
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
    await OutboundTelemetry.drain({ timeoutMs: 2_000 }).catch(() => undefined)
    await disposeDataRootOperation().catch(() => undefined)
    await Log.flush().catch(() => undefined)
    process.exit()
  }
}

await run()
