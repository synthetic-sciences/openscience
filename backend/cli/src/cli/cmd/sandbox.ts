import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Config } from "../../config/config"
import { Sandbox } from "../../sandbox/sandbox"

const S = UI.Style

/** The trusted (global + managed) sandbox policy that actually gets enforced. */
async function effectiveSandbox(): Promise<Config.Sandbox | undefined> {
  return Config.trustedSandbox()
}

function printStatus(config?: Config.Sandbox) {
  const d = Sandbox.describe()
  const enabled = config?.enabled === true

  UI.println(`${S.TEXT_NORMAL_BOLD}Execution sandbox${S.TEXT_NORMAL}`)
  // Three states, not two. "enabled" describes the CONFIG; whether anything is
  // actually confined depends on a backend existing. Keying the sentence off
  // `enabled` alone told a Windows user "agent shell commands are confined to
  // the workspace" on a machine where `Sandbox.backend()` is "none" and nothing
  // confines anything — a false statement about a security property, which is
  // the worst kind of wrong thing for this command to print.
  // Then it printed "are confined to the workspace" on a Windows run whose
  // `sandbox test` failed containment in the very next command. A backend being
  // AVAILABLE is not the same as it working, and this command does not run the
  // commands that would tell the difference — so it now reports what it actually
  // knows (which backend is applied) and names the command that can prove it.
  const effect = !enabled
    ? "run with full user authority"
    : d.available
      ? `are launched through ${d.tool ?? d.backend} - run 'openscience sandbox test' to verify containment`
      : "are NOT confined here: no backend on this platform"
  // Print `effect`, not a second sentence written beside it. The comment above
  // is the whole reason this variable exists — three states, and never claiming
  // containment the machine does not have — and the line below said "are
  // confined to approved paths" whenever `enabled`, which is the two-state
  // sentence `effect` was written to replace. `effect` was computed and
  // discarded, so the bug it fixed was still on screen.
  UI.println(
    `  status    ${enabled ? `${S.TEXT_SUCCESS_BOLD}enabled` : `${S.TEXT_DIM}disabled`}${S.TEXT_NORMAL}` +
      `${S.TEXT_DIM}  (agent shell commands ${effect})${S.TEXT_NORMAL}`,
  )
  UI.println(`  platform  ${d.platform}`)
  UI.println(
    `  backend   ${
      d.available
        ? `${S.TEXT_SUCCESS}${d.backend}${S.TEXT_NORMAL} ${S.TEXT_DIM}(${d.tool})${S.TEXT_NORMAL}`
        : `${S.TEXT_WARNING}unavailable${S.TEXT_NORMAL} ${S.TEXT_DIM}- ${d.reason}${S.TEXT_NORMAL}`
    }`,
  )
  if (enabled) {
    // "allow" is not what it says on bubblewrap or seatbelt: both deny every
    // socket in every mode, because neither can grant outbound access without
    // also exposing everything bound to 127.0.0.1. Printing the configured word
    // alone made this command state a capability the machine does not have.
    const net = config?.network ?? "deny"
    const hollow = net === "allow" && (d.backend === "bubblewrap" || d.backend === "seatbelt")
    UI.println(
      `  network   ${net}` +
        (hollow ? `${S.TEXT_DIM}  (this backend denies all sockets - use 'allowlist')${S.TEXT_NORMAL}` : ""),
    )
    UI.println(
      `  project trust   ${config?.requireProjectTrust ? "required for all execution" : "routine sandboxed work allowed"}`,
    )
    UI.println(`  on missing backend   ${config?.onUnavailable ?? "error"}`)
    if (config?.allowWrite?.length) UI.println(`  extra writable   ${config.allowWrite.join(", ")}`)
    if (config?.allowHosts?.length) UI.println(`  extra hosts   ${config.allowHosts.join(", ")}`)
  }
  if (enabled && !d.available) {
    UI.println("")
    UI.println(
      `  ${S.TEXT_WARNING_BOLD}Note:${S.TEXT_NORMAL} sandbox is on but no backend exists here - ` +
        `execution follows the "${config?.onUnavailable ?? "error"}" fallback policy. It takes effect on machines with a backend.`,
    )
  }
}

async function showStatus() {
  await Instance.provide({
    directory: process.cwd(),
    async fn() {
      printStatus(await effectiveSandbox())
      // A prerequisite the user cannot discover from anything else. On Windows
      // an AppContainer can only be granted access to paths its user owns, so a
      // machine-wide Python is unusable by a sandboxed process however healthy
      // it is — and the only symptom otherwise is an install failing much later
      // with an error about the interpreter rather than about ownership.
      //
      // Printed only when it applies, and worded so nobody reads it as
      // "containment is broken": it is not, and a user who turns the sandbox
      // off over this would lose confinement they still have.
      const { Installer } = await import("../../package/installer")
      const blocked = await Installer.blocked().catch(() => undefined)
      if (blocked) {
        UI.empty()
        for (const line of blocked.split("\n")) UI.println(line ? `  ${S.TEXT_WARNING}${line}${S.TEXT_NORMAL}` : "")
      }
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
        choices: ["deny", "allowlist", "allow"] as const,
        describe: "network egress from sandboxed commands: deny (default), allowlist, or allow",
      })
      .option("allow", {
        type: "string",
        array: true,
        describe: "extra absolute path the sandbox may write to (repeatable)",
      })
      .option("allow-host", {
        type: "string",
        array: true,
        describe: "extra host the sandbox may reach when network is 'allowlist' (repeatable)",
      })
      .option("on-unavailable", {
        choices: ["warn", "error", "allow"] as const,
        describe: "what to do when no backend exists on a machine (default: error)",
      })
      .option("require-project-trust", {
        type: "boolean",
        describe: "require explicit project trust even for routine sandboxed commands",
      }),
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const patch: Partial<Config.Sandbox> = { enabled: true }
        if (args.network) patch.network = args.network
        if (args["on-unavailable"]) patch.onUnavailable = args["on-unavailable"] as "warn" | "error" | "allow"
        if (typeof args["require-project-trust"] === "boolean") {
          patch.requireProjectTrust = args["require-project-trust"]
        }
        // Declared as an option, described in help, and read by nothing: the
        // flag parsed fine and the hosts never reached the config, so a user
        // who ran `sandbox enable --network allowlist --allow-host files.pythonhosted.org`
        // saw success and then a blocked request to exactly that host.
        const hosts = args["allow-host"] as string[] | undefined
        if (hosts?.length) patch.allowHosts = hosts.map((value) => value.trim()).filter(Boolean)
        const allow = args.allow as string[] | undefined
        if (allow?.length) {
          patch.allowWrite = allow.map((value) => {
            const canonical = Sandbox.writableGrant(value)
            if (!canonical) throw new Error(`Writable sandbox path is invalid or over-broad: ${value}`)
            return canonical
          })
        }
        await Config.setSandbox(patch)
        UI.empty()
        UI.println(`${S.TEXT_SUCCESS_BOLD}Sandbox enabled${S.TEXT_NORMAL} ${S.TEXT_DIM}(global config)${S.TEXT_NORMAL}`)
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
  handler: async () => {
    await Config.setSandbox({ enabled: false })
    UI.empty()
    UI.println(`${S.TEXT_NORMAL_BOLD}Sandbox disabled${S.TEXT_NORMAL} ${S.TEXT_DIM}(global config)${S.TEXT_NORMAL}`)
  },
})

const TestCommand = cmd({
  command: "test",
  describe: "prove the sandbox actually confines writes (and network) on this machine",
  handler: async () => {
    UI.empty()
    const result = await Sandbox.selfTest()
    if (!result.available) {
      const d = Sandbox.describe()
      UI.println(`${S.TEXT_WARNING}No sandbox backend available${S.TEXT_NORMAL} - ${d.reason}.`)
      UI.println(`${S.TEXT_DIM}Nothing to test here.${S.TEXT_NORMAL}`)
      return
    }
    UI.println(
      `${S.TEXT_NORMAL_BOLD}Sandbox self-test${S.TEXT_NORMAL} ${S.TEXT_DIM}(${result.backend})${S.TEXT_NORMAL}`,
    )
    for (const c of result.checks) {
      // The glyphs below are only reachable when a backend EXISTS, so they
      // cannot print on Windows today, where the command exits above. Anything
      // printed on a backend-less machine must stay ASCII: a Windows console
      // decodes our UTF-8 as its OEM code page, and an em dash arrived as
      // "\u0393\u00c7\u00f6" in a real run. Keep that rule if a Windows backend lands.
      const mark = c.skipped ? `${S.TEXT_DIM}– skip` : c.pass ? `${S.TEXT_SUCCESS}✓ pass` : `${S.TEXT_DANGER}✗ FAIL`
      UI.println(`  ${mark}${S.TEXT_NORMAL}  ${c.name}${c.detail ? ` ${S.TEXT_DIM}(${c.detail})${S.TEXT_NORMAL}` : ""}`)
    }
    UI.empty()
    UI.println(
      result.ok
        ? `${S.TEXT_SUCCESS_BOLD}Containment verified.${S.TEXT_NORMAL}`
        : `${S.TEXT_DANGER_BOLD}Containment FAILED - do not rely on the sandbox until this passes.${S.TEXT_NORMAL}`,
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
