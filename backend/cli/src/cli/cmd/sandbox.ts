import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Config } from "../../config/config"
import { Sandbox } from "../../sandbox/sandbox"

const S = UI.Style

/** Effective (merged) sandbox config, falling back to global if no instance. */
async function effectiveSandbox(): Promise<Config.Sandbox | undefined> {
  try {
    return (await Config.get()).sandbox
  } catch {
    return (await Config.getGlobal()).sandbox
  }
}

function printStatus(config?: Config.Sandbox) {
  const d = Sandbox.describe()
  const enabled = config?.enabled === true

  UI.println(`${S.TEXT_NORMAL_BOLD}Execution sandbox${S.TEXT_NORMAL}`)
  UI.println(
    `  status    ${enabled ? `${S.TEXT_SUCCESS_BOLD}enabled` : `${S.TEXT_DIM}disabled`}${S.TEXT_NORMAL}` +
      `${S.TEXT_DIM}  (agent shell commands${enabled ? " are confined to the workspace" : " run with full user authority"})${S.TEXT_NORMAL}`,
  )
  UI.println(`  platform  ${d.platform}`)
  UI.println(
    `  backend   ${
      d.available
        ? `${S.TEXT_SUCCESS}${d.backend}${S.TEXT_NORMAL} ${S.TEXT_DIM}(${d.tool})${S.TEXT_NORMAL}`
        : `${S.TEXT_WARNING}unavailable${S.TEXT_NORMAL} ${S.TEXT_DIM}— ${d.reason}${S.TEXT_NORMAL}`
    }`,
  )
  if (enabled) {
    UI.println(`  network   ${config?.network ?? "allow"}`)
    UI.println(`  on missing backend   ${config?.onUnavailable ?? "warn"}`)
    if (config?.allowWrite?.length) UI.println(`  extra writable   ${config.allowWrite.join(", ")}`)
  }
  if (enabled && !d.available) {
    UI.println("")
    UI.println(
      `  ${S.TEXT_WARNING_BOLD}Note:${S.TEXT_NORMAL} sandbox is on but no backend exists here — ` +
        `commands run per "${config?.onUnavailable ?? "warn"}". It takes effect on machines with a backend.`,
    )
  }
}

async function showStatus() {
  await Instance.provide({
    directory: process.cwd(),
    async fn() {
      printStatus(await effectiveSandbox())
    },
  })
}

const StatusCommand = cmd({
  command: ["status", "$0"],
  describe: "show sandbox status (backend + current config)",
  handler: async () => {
    UI.empty()
    await showStatus()
  },
})

const EnableCommand = cmd({
  command: "enable",
  describe: "turn the execution sandbox on",
  builder: (yargs: Argv) =>
    yargs
      .option("network", {
        choices: ["allow", "deny"] as const,
        describe: "allow or deny network egress from sandboxed commands (default: allow)",
      })
      .option("allow", {
        type: "string",
        array: true,
        describe: "extra absolute path the sandbox may write to (repeatable)",
      })
      .option("on-unavailable", {
        choices: ["warn", "error", "allow"] as const,
        describe: "what to do when no backend exists on a machine (default: warn)",
      })
      .option("project", { type: "boolean", describe: "write to the project config instead of the global one" }),
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const patch: Partial<Config.Sandbox> = { enabled: true }
        if (args.network) patch.network = args.network as "allow" | "deny"
        if (args["on-unavailable"]) patch.onUnavailable = args["on-unavailable"] as "warn" | "error" | "allow"
        const allow = args.allow as string[] | undefined
        if (allow?.length) patch.allowWrite = allow
        const scope = args.project ? "project" : "global"
        await Config.setSandbox(patch, scope)
        UI.empty()
        UI.println(
          `${S.TEXT_SUCCESS_BOLD}Sandbox enabled${S.TEXT_NORMAL} ${S.TEXT_DIM}(${scope} config)${S.TEXT_NORMAL}`,
        )
        const d = Sandbox.describe()
        if (!d.available) {
          UI.println(
            `${S.TEXT_WARNING}No sandbox backend on this machine (${d.reason}).${S.TEXT_NORMAL} ` +
              `It will apply where one is available.`,
          )
        }
        UI.empty()
      },
    })
    await showStatus()
    UI.empty()
    UI.println(`${S.TEXT_DIM}Verify it holds:  openscience sandbox test${S.TEXT_NORMAL}`)
  },
})

const DisableCommand = cmd({
  command: "disable",
  describe: "turn the execution sandbox off",
  builder: (yargs: Argv) =>
    yargs.option("project", { type: "boolean", describe: "write to the project config instead of the global one" }),
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const scope = args.project ? "project" : "global"
        await Config.setSandbox({ enabled: false }, scope)
        UI.empty()
        UI.println(
          `${S.TEXT_NORMAL_BOLD}Sandbox disabled${S.TEXT_NORMAL} ${S.TEXT_DIM}(${scope} config)${S.TEXT_NORMAL}`,
        )
      },
    })
  },
})

const TestCommand = cmd({
  command: "test",
  describe: "prove the sandbox actually confines writes (and network) on this machine",
  handler: async () => {
    UI.empty()
    const result = Sandbox.selfTest()
    if (!result.available) {
      const d = Sandbox.describe()
      UI.println(`${S.TEXT_WARNING}No sandbox backend available${S.TEXT_NORMAL} — ${d.reason}.`)
      UI.println(`${S.TEXT_DIM}Nothing to test here.${S.TEXT_NORMAL}`)
      return
    }
    UI.println(
      `${S.TEXT_NORMAL_BOLD}Sandbox self-test${S.TEXT_NORMAL} ${S.TEXT_DIM}(${result.backend})${S.TEXT_NORMAL}`,
    )
    for (const c of result.checks) {
      const mark = c.skipped ? `${S.TEXT_DIM}– skip` : c.pass ? `${S.TEXT_SUCCESS}✓ pass` : `${S.TEXT_DANGER}✗ FAIL`
      UI.println(`  ${mark}${S.TEXT_NORMAL}  ${c.name}${c.detail ? ` ${S.TEXT_DIM}(${c.detail})${S.TEXT_NORMAL}` : ""}`)
    }
    UI.empty()
    UI.println(
      result.ok
        ? `${S.TEXT_SUCCESS_BOLD}Containment verified.${S.TEXT_NORMAL}`
        : `${S.TEXT_DANGER_BOLD}Containment FAILED — do not rely on the sandbox until this passes.${S.TEXT_NORMAL}`,
    )
  },
})

export const SandboxCommand = cmd({
  command: "sandbox",
  describe: "manage the agent execution sandbox (confine shell commands to the workspace)",
  builder: (yargs: Argv) =>
    yargs.command(StatusCommand).command(EnableCommand).command(DisableCommand).command(TestCommand).demandCommand(0),
  handler: async () => {
    UI.empty()
    await showStatus()
  },
})
