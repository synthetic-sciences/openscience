import z from "zod"
import { Environment } from "../package/environment"
import { Installer } from "../package/installer"
import { InstallerR } from "../package/installer-r"
import { Requirement } from "../package/requirement"
import { Instance } from "../project/instance"
import { KernelProcessIdentity } from "../science/kernel/process"
import { KernelRuntime } from "../science/kernel/registry"
import { Tool } from "./tool"

/** The public index, shown on the card and matched by the permission system.
 *  Redacted through `Requirement.redact` so a credentialled mirror never puts
 *  a secret on the card and never fragments a standing grant. */
const DEFAULT_INDEX = Requirement.redact("https://pypi.org/simple")

export const PackageTool = Tool.define("package_install", {
  description: [
    "Install packages into a managed, named environment that kernels can use.",
    "This is the only way to add packages. Shell installers (pip, uv pip, conda, poetry) are refused.",
    "An environment is scoped to one language: Python packages go to a python environment, R packages to an R environment.",
    "A fully-satisfied request installs nothing — check the environment inventory in your context before calling.",
    "Installing restarts kernels bound to that environment only when the change is not purely additive.",
    "Environments are provisioned with uv when it is installed, otherwise with the interpreter's own venv module.",
    // Windows only. bubblewrap and seatbelt read any path the user can read, so
    // this whole consideration is meaningless there — and a tool description is
    // sent on every request, so unconditional platform trivia is a cost every
    // Linux and macOS user pays forever for advice they can never use.
    ...(process.platform === "win32"
      ? [
          "On Windows, prefer uv and suggest it if a user hits an environment problem: an AppContainer can only be granted read access to paths the user owns, so a machine-wide Python (C:\\Python312, C:\\Program Files\\Python) can never be used by a sandboxed run, while uv installs interpreters under the user's own profile.",
        ]
      : []),
  ].join("\n"),
  parameters: z.object({
    packages: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe("Package requirements to install, e.g. ['numpy', 'pandas>=2.2']"),
    environment: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .default("default")
      .describe("Target environment. Created on first install."),
    language: z
      .enum(["python", "r"])
      .default("python")
      .describe("Environment language. An environment is scoped to one."),
    source: z
      .boolean()
      .default(false)
      .describe("Allow source builds. Default is wheels-only, which is faster and more reliable."),
    wait: z
      .boolean()
      .default(true)
      .describe(
        "Wait for the install to finish and report the versions it landed. Set false only for a long install; you then get no versions back and must not claim it succeeded.",
      ),
  }),
  async execute(params, ctx) {
    // Before anything else, and before the approval card: on Windows the
    // sandbox may be unable to reach ANY interpreter, and no amount of asking
    // the user to approve an install changes that. Checked here rather than in
    // `Sandbox.plan` because answering it runs candidate interpreters — far too
    // expensive for a path every sandboxed command takes, and entirely
    // affordable for one deliberate install.
    //
    // This is the surface that matters. Nobody runs `sandbox status`; they hit
    // it when the agent tries. Failing here means the agent is told the remedy
    // at the moment it needs it, instead of inventing one — which it did,
    // advising an admin grant that cannot be obtained and would not have
    // helped.
    //
    // Skipped when THIS environment already exists on a base the sandbox can be
    // granted, which `probe` answers and nothing else does: it is a statement
    // about a machine, and an environment that already works is a counterexample
    // to it. Without this a user whose environment was built correctly is
    // refused an install into it and told to go set up the tool they already
    // have — which is what happened when a parsing bug hid uv's interpreters.
    const project = Instance.project.id
    const name = params.environment
    const directory = Environment.directory(project, name)
    const usable = await Installer.probe(directory)
      .then((tool) => tool.kind === "existing")
      .catch(() => false)
    if (!usable) {
      const blocked = await Installer.blocked().catch(() => undefined)
      if (blocked) throw new Error(blocked)
    }

    const before = await Environment.read(project, name)

    // Parsed for its names only. Resolution happens after approval — the card
    // shows the request, so approving two names must not silently approve the
    // closure they pull in.
    const language = params.language ?? "python"
    // R package names are case-sensitive and `.` is meaningful (`data.table`),
    // so the PEP 503 normalisation Requirement.parse applies is wrong for them:
    // it would turn data.table into data-table and never match what CRAN
    // installed. Python keeps the parser, which is what makes `numpy>=2.4` and
    // `pandas[performance]` safe to accept.
    const parsed =
      language === "r"
        ? params.packages.map((p) => ({ name: p.trim(), extras: [], specifier: "", marker: "", url: "" }))
        : params.packages.map((p) => Requirement.parse(p))

    // Already satisfied: skip outright — no card, no install, no restart.
    // Nothing privileged happens, so nothing needs approving, and a
    // fully-satisfied request is not worth a turn.
    // A bare name is satisfied by any installed version. A requirement that
    // constrains *which* version — a specifier, a direct URL, or extras that
    // may not have been installed — is never assumed satisfied: `six==1.17.0`
    // against an installed 1.16.0 is an upgrade, and skipping it would silently
    // no-op the request and wrongly report the change as additive. Deciding
    // that properly needs PEP 440 comparison; deferring to pip, which already
    // implements it and no-ops when it is genuinely satisfied, is both correct
    // and cheaper than reimplementing it here.
    const constrained = parsed.some((p) => p.specifier || p.url || p.extras.length)
    const satisfied = before && !constrained && parsed.every((p) => before.installed[p.name])
    if (satisfied) {
      // The same metadata shape as the install branch below, deliberately.
      // Two shapes would make every consumer — the UI, the session record, a
      // test — handle a union whose arms differ only in which keys exist.
      const versions = Object.fromEntries(parsed.map((p) => [p.name, before.installed[p.name]!]))
      const listed = Object.entries(versions)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")
      return {
        title: `Already installed · ${name}`,
        output: `Nothing to do. ${listed} already present in ${name}.`,
        metadata: {
          environment: name,
          installed: false,
          ok: true,
          additive: true,
          versions,
          total: before.total,
        },
      }
    }

    const pattern = Requirement.pattern({
      packages: params.packages,
      environment: name,
      index: DEFAULT_INDEX,
    })

    ctx.metadata({ title: `Install · ${name}`, metadata: { environment: name, packages: params.packages } })

    // The ordinary contract, not modal's. Installing a library must not be
    // gated more strictly than running arbitrary code, because it costs
    // nothing — hence no digest and no spendFilter entry. The command string is
    // readable, and changes whenever the approved action changes, so the prompt
    // reappears for free when it should.
    await ctx.ask({
      permission: "package_install",
      patterns: [pattern],
      always: ["install*"],
      metadata: { environment: name, packages: params.packages, index: DEFAULT_INDEX },
    })

    // Dispatch without waiting. The lock is still taken, so a second install
    // queues exactly as it would otherwise; what changes is that this turn does
    // not hold open for it. The claim is written before returning so a CLI
    // restart mid-install can tell "still running" from "died", and the output
    // deliberately reports no versions — there are none yet, and inventing them
    // is precisely what the contract forbids.
    if (params.wait === false) {
      const running = Environment.lock(project, name, async () => {
        await Environment.claim(project, name, process.pid, KernelProcessIdentity.startToken(process.pid))
        try {
          const value = await install()
          await Environment.release(project, name)
          return value
        } catch (error) {
          // Recorded, not swallowed. Nothing is awaiting this promise, so a
          // discarded rejection meant the agent was told "started installing"
          // and could never learn otherwise: no manifest written, claim cleared,
          // no trace anywhere. The failure now replaces the claim and surfaces
          // in the environment inventory on the next request.
          await Environment.fail(project, name, error instanceof Error ? error.message : String(error))
          throw error
        }
      })
      // Already recorded above; this only stops an unobserved rejection
      // surfacing as a process-level warning with no context.
      running.catch(() => undefined)
      return {
        title: `Installing · ${name}`,
        output: [
          `Started installing ${params.packages.join(", ")} into ${name}.`,
          `It is still running. Do not execute in this environment, and do not report a version, until a later call confirms what landed.`,
        ].join("\n"),
        metadata: { environment: name, installed: false, ok: true, additive: true, versions: {}, total: 0 },
      }
    }

    return await Environment.lock(project, name, install)

    async function install() {
      // Only the backend differs by language. The card, the lock, the manifest
      // write and the additivity check are identical, because they are
      // properties of the contract rather than of pip or CRAN.
      const r = language === "r"
      if (r) await InstallerR.create(directory)
      const tool = r ? undefined : await Installer.probe(directory)
      if (tool) await Installer.create(directory, tool)

      // Two different questions, deliberately asked of two different sources.
      // `owned` is what the environment itself holds and becomes the manifest.
      // `seen` is everything the interpreter can import, inherited packages
      // included, and is the only correct basis for the restart decision:
      // requesting a version the host already provides installs nothing
      // locally, so an owned-set comparison reads the NEXT version as an
      // addition and leaves stale modules loaded in live kernels.
      const owned = () => (r ? InstallerR.freeze(directory) : Installer.freeze(directory))
      const seen = () => (r ? InstallerR.resolved(directory) : Installer.resolved(directory))
      const snapshot = await seen()

      // Report what pip is doing while it does it. A tool with no dedicated
      // renderer otherwise shows its name and an ellipsis for the whole call —
      // measured at 1m37s for a pytorch install, with pip reporting phase and
      // size the entire time. `metadata` is re-read as the call runs, so this
      // reaches the running row; `input` is fixed at call time and cannot.
      const progress = (status: string) =>
        ctx.metadata({
          title: `Install · ${name}`,
          metadata: { environment: name, packages: params.packages, progress: status },
        })

      const result = r
        ? await InstallerR.install({ directory, packages: params.packages, signal: ctx.abort })
        : await Installer.install({
            directory,
            packages: params.packages,
            index: "",
            source: params.source,
            signal: ctx.abort,
            onProgress: progress,
          })

      // Modern pip builds every wheel before the install phase, so a build
      // failure aborts before anything is committed — verified during design,
      // where a failing package's cleanly-resolving dependency was downloaded
      // and still not installed. There is no subset to keep and nothing to
      // retry, so this reports the cause and stops. R is checked explicitly by
      // InstallerR, because install.packages() only warns and still exits 0.
      if (!result.ok) throw new Error(r ? InstallerR.explain(result.log) : Installer.explain(result.log))

      const after = await seen()
      const held = await owned()
      const names = parsed.map((p) => p.name)
      const versions = r ? await InstallerR.verify(directory, names) : await Installer.verify(directory, names)

      const requested = Array.from(new Set([...(before?.requested ?? []), ...parsed.map((p) => p.name)]))
      await Environment.write(project, {
        name,
        // Defaulted here rather than relied on from the schema: `execute` is
        // reachable without zod having applied parameter defaults, and an
        // undefined language used to produce a manifest that could never be
        // read back.
        language,
        requested,
        installed: held,
        total: Object.keys(held).length,
        createdAt: before?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      })

      // Kernels bind to the environment *directory*, so that is what identifies
      // them here — not the name, which the registry never sees.
      const additive = Environment.additive(snapshot, after)
      if (!additive) await KernelRuntime.restartEnvironment(project, directory)

      const landed = Object.entries(versions)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")
      return {
        title: `Installed · ${name}`,
        output: [
          `Installed into ${name}: ${landed || "(nothing reported)"}.`,
          `${Object.keys(held).length} packages total in the environment.`,
          additive
            ? "Purely additive — running kernels kept their state."
            : "Not purely additive — kernels bound to this environment restarted and their variables were discarded.",
        ].join("\n"),
        metadata: {
          environment: name,
          installed: true,
          ok: true,
          additive,
          versions,
          total: Object.keys(held).length,
        },
      }
    }
  },
})
