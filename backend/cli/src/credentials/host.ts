import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { Log } from "../util/log"

/**
 * Credentials the machine already holds for publishing destinations: the
 * GitHub login `gh` keeps, and the Hugging Face token the `hf` CLI stores.
 * Values are read on the host, outside any project sandbox, and only ever
 * handed to a command the user approved for network access. They are never
 * shown to the model; status reads report presence and source only.
 */
export namespace HostCredentials {
  const log = Log.create({ service: "host-credentials" })

  export type Service = "github" | "huggingface"
  export type Source = "environment" | "gh" | "huggingface-cli" | "token-file"
  export type Found = { service: Service; token: string; source: Source }
  export type Status = { service: Service; available: boolean; source?: Source }

  const TTL_MS = 5 * 60_000
  let cache: { at: number; found: Found[] } | undefined

  // A desktop app launched from the Dock inherits a short PATH; the CLIs the
  // user installed with Homebrew or pipx still count as this machine's logins.
  const EXTRA_BIN = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")]

  function locate(file: string) {
    return Bun.which(file) ?? Bun.which(file, { PATH: EXTRA_BIN.join(path.delimiter) }) ?? undefined
  }

  async function run(file: string, args: string[], timeoutMs = 4_000): Promise<string | undefined> {
    const binary = locate(file)
    if (!binary) return
    const proc = Bun.spawn([binary, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
    })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const text = await new Response(proc.stdout).text().catch(() => "")
    const code = await proc.exited
    clearTimeout(timer)
    if (code !== 0) return
    const value = text.trim()
    return value || undefined
  }

  async function github(): Promise<Found | undefined> {
    const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    if (env) return { service: "github", token: env, source: "environment" }
    const token = await run("gh", ["auth", "token", "--hostname", "github.com"])
    if (token) return { service: "github", token, source: "gh" }
    return undefined
  }

  async function huggingface(): Promise<Found | undefined> {
    const env = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN
    if (env) return { service: "huggingface", token: env, source: "environment" }
    const home = process.env.HF_HOME || path.join(os.homedir(), ".cache", "huggingface")
    const file = process.env.HF_TOKEN_PATH || path.join(home, "token")
    const stored = await fs
      .readFile(file, "utf8")
      .then((value) => value.trim())
      .catch(() => "")
    if (stored) return { service: "huggingface", token: stored, source: "token-file" }
    const token = (await run("hf", ["auth", "token"])) ?? (await run("huggingface-cli", ["whoami", "--token"]))
    if (token && /^hf_/.test(token)) return { service: "huggingface", token, source: "huggingface-cli" }
    return undefined
  }

  /** Every credential the host can supply, cached briefly so a burst of
   * approved commands does not shell out repeatedly. */
  export async function discover(options: { fresh?: boolean } = {}): Promise<Found[]> {
    if (!options.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.found
    const found = (await Promise.all([github(), huggingface()])).filter((value): value is Found => !!value)
    cache = { at: Date.now(), found }
    log.info("discovered host credentials", { services: found.map((item) => `${item.service}:${item.source}`) })
    return found
  }

  export function forget() {
    cache = undefined
  }

  /** Presence and source only; safe to return to a client or a model. */
  export async function status(options: { fresh?: boolean } = {}): Promise<Status[]> {
    const found = await discover(options)
    return (["github", "huggingface"] as const).map((service) => {
      const match = found.find((item) => item.service === service)
      return match ? { service, available: true, source: match.source } : { service, available: false }
    })
  }

  /** Environment for one approved network command: tokens under the names the
   * tools read, plus a git credential helper that answers with the GitHub
   * token so HTTPS pushes never prompt. The helper lives in the command's
   * private temporary directory, which the sandbox already exposes. */
  export async function publishEnv(directory: string | undefined, found: Found[]): Promise<Record<string, string>> {
    const env: Record<string, string> = {}
    // Unsandboxed commands have no private temporary directory; the helper
    // never embeds a token (it echoes $GH_TOKEN), so a plain temp dir is fine.
    const temporary = directory ?? (await fs.mkdtemp(path.join(os.tmpdir(), "openscience-publish-")))
    const github = found.find((item) => item.service === "github")
    const hf = found.find((item) => item.service === "huggingface")
    if (hf) {
      env.HF_TOKEN = hf.token
      env.HUGGING_FACE_HUB_TOKEN = hf.token
    }
    if (github) {
      env.GH_TOKEN = github.token
      env.GITHUB_TOKEN = github.token
      {
        const helper = path.join(temporary, "git-credential-openscience")
        // `git credential fill` speaks the credential protocol on stdin; the
        // helper answers with the token for any GitHub host it is asked about.
        await fs.writeFile(
          helper,
          [
            "#!/bin/sh",
            'if [ "$1" != "get" ]; then exit 0; fi',
            'printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"',
            "",
          ].join("\n"),
          { mode: 0o700 },
        )
        env.GIT_CONFIG_COUNT = "2"
        env.GIT_CONFIG_KEY_0 = "credential.https://github.com.helper"
        env.GIT_CONFIG_VALUE_0 = `!${helper}`
        env.GIT_CONFIG_KEY_1 = "credential.https://github.com.useHttpPath"
        env.GIT_CONFIG_VALUE_1 = "false"
      }
    }
    // SSH remotes authenticate through the user's agent; host keys for a first
    // contact are accepted the way a fresh clone would, since the user just
    // approved this exact command.
    if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
    env.GIT_SSH_COMMAND = `ssh -o UserKnownHostsFile=${path.join(temporary, "known_hosts")} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`
    return env
  }
}
