import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import type { ComputeSettings } from "../server/routes/settings/compute"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { CredentialProcessLedger } from "../credentials/process-ledger"
import { CredentialRevocation } from "../credentials/revocation"
import { ProcessIdentity } from "../process/process-identity"
import { WindowsJobLauncher } from "../process/windows-job-launcher"
import { DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX } from "../process/darwin-responsibility-launcher"
import { OpenScience } from "../openscience"
import { Shell } from "../shell/shell"
import { TrustedExecutable } from "../process/trusted-executable"

async function settings() {
  return (await import("../server/routes/settings/compute")).ComputeSettings
}

/**
 * Reviewed, read-only provider CLI bridge.
 *
 * This is deliberately not a general command runner. Every executable and
 * argument is owned here, no shell is involved, and the provider credential is
 * admitted only into the exact child environment. Resource creation, mutation,
 * and deletion remain unavailable through this bridge.
 */
export namespace ProviderCli {
  export const PROVIDERS = ["tensorpool", "lambda", "prime_intellect", "vast", "runpod"] as const
  export type Provider = (typeof PROVIDERS)[number]
  export const OPERATIONS = [
    "account",
    "list_resources",
    "resource_status",
    "list_jobs",
    "job_status",
    "list_availability",
  ] as const
  export type Operation = (typeof OPERATIONS)[number]

  interface Spec {
    cli: string
    args: string[]
    display: string
    docs: string
    environment: string[]
    stdin?: (env: Record<string, string>) => Buffer
  }

  const DOCTOR_SPECS: Record<Provider, Spec> = {
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

  const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

  function lambda(url: string): Spec {
    return {
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
        url,
        "--header",
        "accept: application/json",
        "--header",
        "@-",
      ],
      display: `curl GET ${url}`,
      docs: "https://docs.lambda.ai/public-cloud/cloud-api/",
      environment: [],
      stdin: (env) => Buffer.from(`Authorization: Bearer ${env.LAMBDA_API_KEY}\n`, "utf8"),
    }
  }

  function operationSpec(target: Provider, operation: Operation, resourceID?: string): Spec {
    const needsID = operation === "resource_status" || operation === "job_status"
    if (needsID && (!resourceID || !RESOURCE_ID.test(resourceID))) {
      throw new Error(
        `${operation} requires a provider resource id using only letters, numbers, dot, colon, dash, or underscore`,
      )
    }
    if (!needsID && resourceID !== undefined) throw new Error(`${operation} does not accept a resource id`)
    const id = resourceID!

    if (target === "tensorpool") {
      const common = { cli: "tp", docs: "https://docs.tensorpool.dev/cli/overview", environment: ["TENSORPOOL_KEY"] }
      if (operation === "account") return { ...common, args: ["--no-input", "me"], display: "tp --no-input me" }
      if (operation === "list_resources") return { ...common, args: ["cluster", "list"], display: "tp cluster list" }
      if (operation === "resource_status")
        return { ...common, args: ["cluster", "info", id], display: `tp cluster info ${id}` }
      if (operation === "list_jobs") return { ...common, args: ["job", "list"], display: "tp job list" }
      if (operation === "job_status") return { ...common, args: ["job", "info", id], display: `tp job info ${id}` }
    }

    if (target === "lambda") {
      if (operation === "account" || operation === "list_resources") {
        return lambda("https://cloud.lambda.ai/api/v1/instances")
      }
      if (operation === "resource_status") {
        return lambda(`https://cloud.lambda.ai/api/v1/instances/${encodeURIComponent(id)}`)
      }
      if (operation === "list_availability") return lambda("https://cloud.lambda.ai/api/v1/instance-types")
    }

    if (target === "prime_intellect") {
      const common = {
        cli: "prime",
        docs: "https://docs.primeintellect.ai/cli-reference/introduction",
        environment: ["PRIME_API_KEY"],
      }
      if (operation === "account") return { ...common, args: ["whoami"], display: "prime whoami" }
      if (operation === "list_resources") return { ...common, args: ["pods", "list"], display: "prime pods list" }
      if (operation === "resource_status")
        return { ...common, args: ["pods", "status", id], display: `prime pods status ${id}` }
      if (operation === "list_availability")
        return { ...common, args: ["availability", "list"], display: "prime availability list" }
    }

    if (target === "vast") {
      const common = { cli: "vastai", docs: "https://docs.vast.ai/cli/", environment: ["VAST_API_KEY"] }
      if (operation === "account")
        return { ...common, args: ["show", "user", "--raw"], display: "vastai show user --raw" }
      if (operation === "list_resources")
        return { ...common, args: ["show", "instances", "--raw"], display: "vastai show instances --raw" }
      if (operation === "resource_status")
        return { ...common, args: ["show", "instance", id, "--raw"], display: `vastai show instance ${id} --raw` }
    }

    if (target === "runpod") {
      const common = {
        cli: "runpodctl",
        docs: "https://docs.runpod.io/runpodctl/overview",
        environment: ["RUNPOD_API_KEY"],
      }
      if (operation === "account") return { ...common, args: ["user"], display: "runpodctl user" }
      if (operation === "list_resources")
        return { ...common, args: ["pod", "list", "--all"], display: "runpodctl pod list --all" }
      if (operation === "resource_status")
        return { ...common, args: ["pod", "get", id], display: `runpodctl pod get ${id}` }
      if (operation === "list_availability") return { ...common, args: ["gpu", "list"], display: "runpodctl gpu list" }
    }

    throw new Error(`${target} does not support the reviewed read-only ${operation} operation`)
  }

  export interface Preview {
    provider: Provider
    operation: Operation
    cli: string
    command: string
    docs: string
  }

  export function preview(targetInput: string, operation: Operation, resourceID?: string): Preview {
    const target = provider(targetInput)
    const spec = operationSpec(target, operation, resourceID)
    return { provider: target, operation, cli: spec.cli, command: spec.display, docs: spec.docs }
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
    if (!(canonical in DOCTOR_SPECS)) throw new Error(`Compute provider ${target} has no reviewed native CLI broker`)
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

  export interface InvokeOptions {
    /** Isolated fake-CLI roots for tests. Production callers never override
     * the fixed trusted search roots. */
    executableDirectories?: string[]
    timeoutMs?: number
    signal?: AbortSignal
    /** Deterministic TOCTOU barrier used only by the executable-boundary
     * regression. Rejected unless the server itself is running under the test
     * home established by test/preload.ts. */
    testAfterExecutableVerification?: (executablePath: string) => void | Promise<void>
    /** Exercise the production immutable-authority check for a fake test CLI. */
    testRequireImmutableAuthority?: boolean
    /** Synchronize a lifecycle test after durable wrapper registration but
     * before its operation timeout is armed. */
    testAfterLaunchRegistration?: () => void | Promise<void>
  }

  interface InvokeResult {
    ok: boolean
    provider: Provider
    cli: string
    command: string
    checked_at: string
    output?: string
    error?: string
  }

  function allowMutableTestRoot(options: Pick<InvokeOptions, "executableDirectories">) {
    return Boolean(options.executableDirectories?.length && process.env.OPENSCIENCE_TEST_HOME)
  }

  async function approve(
    target: Provider,
    spec: Spec,
    options: Pick<InvokeOptions, "executableDirectories" | "testRequireImmutableAuthority">,
  ) {
    const selected = await TrustedExecutable.attest(spec.cli, { directories: options.executableDirectories })
    if (!selected) throw new Error(`${spec.cli} is not installed. Install it from ${spec.docs}, then retry.`)
    await TrustedExecutable.assertImmutableAuthority(selected, {
      allowMutableTestRoot: allowMutableTestRoot(options),
    })
    const store = await settings()
    const pinned = await store.approveProviderExecutable(target, selected)
    await TrustedExecutable.revalidate(pinned)
    await TrustedExecutable.assertImmutableAuthority(pinned, {
      allowMutableTestRoot: allowMutableTestRoot(options),
    })
    return pinned
  }

  async function invoke(
    target: Provider,
    spec: Spec,
    options: InvokeOptions = {},
    explicitSettingsApproval = false,
  ): Promise<InvokeResult> {
    const checked = new Date().toISOString()
    const store = await settings()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `openscience-${target}-provider-`))
    let launched: Awaited<ReturnType<typeof launch>> | undefined
    let credentialRevision: string | undefined
    try {
      if (options.signal?.aborted) throw new Error(`${spec.cli} operation was cancelled before launch`)
      const pinned = explicitSettingsApproval
        ? await approve(target, spec, options)
        : await store.approvedProviderExecutable(target)
      await TrustedExecutable.revalidate(pinned)
      await TrustedExecutable.assertImmutableAuthority(pinned, {
        allowMutableTestRoot: allowMutableTestRoot(options),
      })
      const result = await store.withProviderEnv(target, process.env, async (provided, revision) => {
        if (options.signal?.aborted) throw new Error(`${spec.cli} operation was cancelled before launch`)
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
        // Re-open and hash the exact pinned path after credential admission.
        // The following immutable-authority proof closes both pathname-swap
        // and same-inode rewrite windows before spawn: in production the file
        // and every ancestor are outside same-user write authority.
        const binary = await TrustedExecutable.revalidate(pinned)
        if (options.testAfterExecutableVerification) {
          if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("Provider CLI test hooks are disabled outside tests")
          await options.testAfterExecutableVerification(binary)
        }
        await TrustedExecutable.assertImmutableAuthority(pinned, {
          allowMutableTestRoot: allowMutableTestRoot(options) && !options.testRequireImmutableAuthority,
        })
        launched = await launch(
          target,
          spec,
          binary,
          { ...isolated, PATH: TrustedExecutable.searchPath({ systemOnly: true }) },
          root,
          stdin,
        )
        return { launched: true as const }
      })
      if (!result.launched) throw new Error(`${spec.cli} launch did not establish executable authority`)
      if (!launched || !credentialRevision) throw new Error(`${spec.cli} launch did not establish credential authority`)
      if (options.testAfterLaunchRegistration) {
        if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("Provider CLI test hooks are disabled outside tests")
        await options.testAfterLaunchRegistration()
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${spec.cli} operation timed out after ${options.timeoutMs ?? TIMEOUT}ms`)),
          options.timeoutMs ?? TIMEOUT,
        )
      })
      const cancelled = new Promise<never>((_, reject) => {
        if (!options.signal) return
        abort = () => reject(new Error(`${spec.cli} operation was cancelled`))
        if (options.signal.aborted) abort()
        else options.signal.addEventListener("abort", abort, { once: true })
      })
      try {
        const [stdout, stderr, status] = await Promise.race([
          Promise.all([launched.stdout, launched.stderr, launched.completion] as const),
          timeout,
          cancelled,
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
        await store.markProviderUsed(target, credentialRevision)
        return {
          ok: true,
          provider: target,
          cli: spec.cli,
          command: spec.display,
          checked_at: checked,
          output: OpenScience.redactSecrets(stdout.toString("utf8").trim()),
        }
      } finally {
        if (timer) clearTimeout(timer)
        if (abort) options.signal?.removeEventListener("abort", abort)
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

  export interface OperationResult extends InvokeResult {
    operation: Operation
  }

  /** Record executable approval without admitting a credential. The Settings
   * doctor is the production caller; the direct export keeps broker contract
   * tests from having to run a provider-specific account command first. */
  export async function approveExecutable(
    targetInput: string,
    options: { executableDirectories?: string[]; testRequireImmutableAuthority?: boolean } = {},
  ): Promise<TrustedExecutable.Attestation> {
    const target = provider(targetInput)
    return approve(target, DOCTOR_SPECS[target], options)
  }

  /** Execute one provider-owned read operation. The caller selects only a
   * reviewed operation and an opaque resource id; it can never supply argv,
   * an executable, an endpoint, an environment variable, or a request body. */
  export async function execute(
    targetInput: string,
    operation: Operation,
    resourceID?: string,
    options: InvokeOptions = {},
  ): Promise<OperationResult> {
    const target = provider(targetInput)
    const spec = operationSpec(target, operation, resourceID)
    return { ...(await invoke(target, spec, options)), operation }
  }

  export async function doctor(
    targetInput: string,
    options: { executableDirectories?: string[] } = {},
  ): Promise<ComputeSettings.ProviderDoctor> {
    const target = provider(targetInput)
    // This path is called only by the user's explicit Settings connection
    // check. Agent provider operations never create trust on first use.
    const result = await invoke(target, DOCTOR_SPECS[target], options, true)
    if (!result.ok) await (await settings()).markProviderCheckFailed(target)
    const { output: _output, ...doctor } = result
    return doctor
  }
}

// An expired synced overlay reaches only helpers that inherited it.
CredentialLifecycle.onRevoke(async ({ reason }) => {
  await CredentialProcessLedger.revoke({ kind: "provider", ...CredentialRevocation.scope(reason) })
})
