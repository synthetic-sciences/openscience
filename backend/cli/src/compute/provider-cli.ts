import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { ComputeSettings } from "../server/routes/settings/compute"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { CredentialProcessLedger } from "../credentials/process-ledger"
import { ProcessIdentity } from "../process/process-identity"
import { WindowsJobLauncher } from "../process/windows-job-launcher"
import { DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX } from "../process/darwin-responsibility-launcher"
import { OpenScience } from "../openscience"
import { Shell } from "../shell/shell"
import { TrustedExecutable } from "../process/trusted-executable"

/**
 * Reviewed, read-only provider CLI bridge.
 *
 * This is deliberately not a general command runner. Every executable and
 * argument is owned here, no shell is involved, and the provider credential is
 * admitted only into the exact child environment. Resource creation, mutation,
 * and deletion remain unavailable through this bridge.
 */
export namespace ProviderCli {
  type Provider = "tensorpool" | "lambda" | "prime_intellect" | "vast" | "runpod"

  interface Spec {
    cli: string
    args: string[]
    display: string
    docs: string
    environment: string[]
    stdin?: (env: Record<string, string>) => Buffer
  }

  const SPECS: Record<Provider, Spec> = {
    tensorpool: {
      cli: "tp",
      args: ["--no-input", "me"],
      display: "tp --no-input me",
      docs: "https://docs.tensorpool.dev/cli/overview",
      environment: ["TENSORPOOL_KEY"],
    },
    lambda: {
      // Lambda's official Cloud API documentation uses curl. Header input is
      // supplied on stdin so the bearer token never appears in argv or a file.
      cli: "curl",
      args: [
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--max-time",
        "12",
        "--request",
        "GET",
        "--url",
        "https://cloud.lambda.ai/api/v1/instances",
        "--header",
        "accept: application/json",
        "--header",
        "@-",
      ],
      display: "curl GET https://cloud.lambda.ai/api/v1/instances",
      docs: "https://docs.lambda.ai/public-cloud/cloud-api/",
      environment: [],
      stdin: (env) => Buffer.from(`Authorization: Bearer ${env.LAMBDA_API_KEY}\n`, "utf8"),
    },
    prime_intellect: {
      cli: "prime",
      args: ["whoami"],
      display: "prime whoami",
      docs: "https://docs.primeintellect.ai/cli-reference/introduction",
      environment: ["PRIME_API_KEY"],
    },
    vast: {
      cli: "vastai",
      args: ["show", "user", "--raw"],
      display: "vastai show user --raw",
      docs: "https://docs.vast.ai/cli/authentication",
      environment: ["VAST_API_KEY"],
    },
    runpod: {
      cli: "runpodctl",
      args: ["user"],
      display: "runpodctl user",
      docs: "https://docs.runpod.io/runpodctl/overview",
      environment: ["RUNPOD_API_KEY"],
    },
  }

  const MAX_STDOUT = 256 * 1024
  const MAX_STDERR = 64 * 1024
  const TIMEOUT = 15_000
  const RUNTIME_ENV = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]

  function provider(target: string): Provider {
    const canonical = target === "prime" ? "prime_intellect" : target
    if (!(canonical in SPECS)) throw new Error(`Compute provider ${target} has no reviewed native CLI broker`)
    return canonical as Provider
  }

  function output(stream: NodeJS.ReadableStream, limit: number, label: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error)
      }
      stream.on("data", (value: Buffer | string) => {
        if (settled) return
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        size += chunk.length
        if (size > limit) {
          fail(new Error(`${label} exceeded ${limit} bytes`))
          return
        }
        chunks.push(chunk)
      })
      stream.once("error", fail)
      stream.once("end", () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks, size))
      })
    })
  }

  async function cleanupGate(release?: string) {
    if (!release) return
    await Promise.all([
      fs.rm(release, { force: true }).catch(() => undefined),
      fs.rm(`${release}${DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX}`, { force: true }).catch(() => undefined),
    ])
  }

  async function complete(id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await CredentialProcessLedger.complete(id)) return
      await Bun.sleep(20)
    }
    await CredentialProcessLedger.revoke({ id, kind: "provider" })
  }

  async function stop(id: string, child: ChildProcess, detached: boolean, identity?: string) {
    const failures: unknown[] = []
    await CredentialProcessLedger.revoke({ id, kind: "provider" }).catch((error) => failures.push(error))
    const stillOwned = child.pid && identity ? await CredentialProcessLedger.owns(child.pid, identity) : true
    if (stillOwned && child.exitCode === null && child.signalCode === null) {
      await Shell.killTree(child, {
        detached,
        exited: () => child.exitCode !== null || child.signalCode !== null,
      }).catch((error) => failures.push(error))
    }
    if (failures.length) throw new AggregateError(failures, "Provider CLI process could not be stopped")
  }

  async function launch(
    target: Provider,
    spec: Spec,
    executablePath: string,
    environment: Record<string, string>,
    cwd: string,
    stdin?: Buffer,
  ) {
    const linuxOwner =
      process.platform === "linux"
        ? await ProcessIdentity.capture(process.pid).then((identity) =>
            identity ? { pid: process.pid, identity } : undefined,
          )
        : undefined
    if (process.platform === "linux" && !linuxOwner) {
      throw new Error(`Could not capture the server identity for ${target} CLI launch`)
    }
    const wrapped = WindowsJobLauncher.wrap({ file: executablePath, args: spec.args, linuxOwner })
    const detached = process.platform !== "win32"
    const child = spawn(wrapped.file, wrapped.args, {
      cwd,
      env: environment,
      detached,
      windowsHide: true,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    })
    WindowsJobLauncher.bind(child, wrapped.release)
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    const stdout = output(child.stdout!, MAX_STDOUT, `${spec.cli} stdout`)
    const stderr = output(child.stderr!, MAX_STDERR, `${spec.cli} stderr`)
    void completion.catch(() => undefined)
    void stdout.catch(() => undefined)
    void stderr.catch(() => undefined)
    const id = `provider-${target}-${crypto.randomUUID()}`
    let identity: string | undefined
    try {
      if (!child.pid) throw new Error(`${spec.cli} started without a process id`)
      identity = await CredentialProcessLedger.identity(child.pid)
      if (!identity) throw new Error(`Could not establish a safe identity for ${spec.cli}`)
      const registered = await CredentialProcessLedger.register({
        id,
        kind: "provider",
        pid: child.pid,
        detached,
        identity,
        windowsRelease: wrapped.release,
      })
      if (!registered) throw new Error(`${spec.cli} exited before durable ownership was established`)
      if (process.platform === "linux" && wrapped.release) await WindowsJobLauncher.release(wrapped.release, child.pid)
      if (stdin) child.stdin!.end(stdin)
      return { id, child, detached, identity, release: wrapped.release, completion, stdout, stderr }
    } catch (error) {
      await stop(id, child, detached, identity).catch(() => undefined)
      await cleanupGate(wrapped.release)
      throw error
    }
  }

  export async function doctor(
    targetInput: string,
    options: { executableDirectories?: string[] } = {},
  ): Promise<ComputeSettings.ProviderDoctor> {
    const target = provider(targetInput)
    const spec = SPECS[target]
    const checked = new Date().toISOString()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `openscience-${target}-doctor-`))
    let launched: Awaited<ReturnType<typeof launch>> | undefined
    let credentialRevision: string | undefined
    try {
      const result = await ComputeSettings.withProviderEnv(target, process.env, async (provided, revision) => {
        credentialRevision = revision
        const stdin = spec.stdin?.(provided)
        const native = Object.fromEntries(
          spec.environment.flatMap((name) => (provided[name] === undefined ? [] : [[name, provided[name]!]])),
        )
        const runtime = Object.fromEntries(
          RUNTIME_ENV.flatMap((name) => (provided[name] === undefined ? [] : [[name, provided[name]!]])),
        )
        const isolated = {
          ...runtime,
          ...native,
          HOME: root,
          USERPROFILE: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          TMPDIR: path.join(root, "tmp"),
          TMP: path.join(root, "tmp"),
          TEMP: path.join(root, "tmp"),
          NO_COLOR: "1",
          CI: "1",
        }
        await Promise.all([
          fs.mkdir(isolated.XDG_CONFIG_HOME, { recursive: true }),
          fs.mkdir(isolated.XDG_CACHE_HOME, { recursive: true }),
          fs.mkdir(isolated.XDG_STATE_HOME, { recursive: true }),
          fs.mkdir(isolated.TMPDIR, { recursive: true }),
        ])
        const binary = await TrustedExecutable.resolve(spec.cli, { directories: options.executableDirectories })
        if (!binary) return { missing: true as const }
        launched = await launch(
          target,
          spec,
          binary,
          { ...isolated, PATH: TrustedExecutable.searchPath() },
          root,
          stdin,
        )
        return { missing: false as const }
      })
      if (result.missing) {
        return {
          ok: false,
          provider: target,
          cli: spec.cli,
          command: spec.display,
          checked_at: checked,
          error: `${spec.cli} is not installed. Install it from ${spec.docs}, then retry.`,
        }
      }
      if (!launched || !credentialRevision) throw new Error(`${spec.cli} launch did not establish credential authority`)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${spec.cli} connection check timed out after ${TIMEOUT}ms`)),
          TIMEOUT,
        )
      })
      try {
        const [stdout, stderr, status] = await Promise.race([
          Promise.all([launched.stdout, launched.stderr, launched.completion] as const),
          timeout,
        ])
        if (status.code !== 0) {
          const detail = OpenScience.redactSecrets(stderr.toString("utf8").trim() || stdout.toString("utf8").trim())
          return {
            ok: false,
            provider: target,
            cli: spec.cli,
            command: spec.display,
            checked_at: checked,
            error: detail
              ? `${spec.cli} rejected the connection: ${detail.slice(0, 600)}`
              : `${spec.cli} exited with code ${status.code}`,
          }
        }
        await ComputeSettings.markProviderUsed(target, credentialRevision)
        return { ok: true, provider: target, cli: spec.cli, command: spec.display, checked_at: checked }
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch (error) {
      if (launched) await stop(launched.id, launched.child, launched.detached, launched.identity).catch(() => undefined)
      return {
        ok: false,
        provider: target,
        cli: spec.cli,
        command: spec.display,
        checked_at: checked,
        error: OpenScience.redactSecrets(error instanceof Error ? error.message : String(error)),
      }
    } finally {
      if (launched) {
        await complete(launched.id).catch(() => undefined)
        await cleanupGate(launched.release)
      }
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

CredentialLifecycle.onRevoke(async () => {
  await CredentialProcessLedger.revoke("provider")
})
