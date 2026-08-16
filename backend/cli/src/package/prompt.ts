import z from "zod"
// Aliased: this namespace exports its own `Environment` (the render schema),
// which would shadow the store inside every function body here.
import { Environment as Store } from "./environment"

/**
 * Capability contract for governed package installation.
 *
 * Modelled on `compute/prompt.ts`. The load-bearing mechanism there is not the
 * skill override — it is `SystemPrompt.compute()`, injected unconditionally at
 * `session/prompt.ts:863` on every request for every agent. That is what makes
 * a contract hold across 293 skills, their reference files, and third-party
 * skills cloned from GitHub that this repo cannot edit: it pre-empts rather
 * than corrects, and it names the specific wrong commands rather than
 * gesturing at a policy.
 *
 * Wire the same way — add `...(await SystemPrompt.packages())` to the system
 * array. A skill-level override is deliberately NOT provided: it only reaches
 * the front page of a skill, never its references, and the block below already
 * covers what such an override would say.
 */
export namespace PackagePrompt {
  export const Environment = z.object({
    name: z.string(),
    language: z.enum(["python", "r"]),
    /**
     * Only what was explicitly asked for, never the resolved closure.
     *
     * A real environment listing is dominated by transitive and native
     * dependencies — a reference implementation's shared env reports 168
     * entries, most of them `libgcc`, `harfbuzz`, `xorg-libx11`, `qt6-main`,
     * with the importable Python packages a minority. Rendering that into every
     * request would bury the contract in font libraries and teach the agent
     * nothing it can act on.
     */
    requested: z.array(z.string()).default([]),
    /** Size of the resolved closure, reported as a number rather than listed. */
    total: z.number().int().nonnegative().optional(),
    /** Set while an install holds this env's lock. */
    busy: z.boolean().default(false),
  })
  export type Environment = z.infer<typeof Environment>

  const Stored = z
    .object({
      environments: z.array(Environment).default([]),
      /** Outcomes of installs that finished without anyone watching. */
      warnings: z.array(z.string()).default([]),
    })
    .passthrough()

  const inventory = (values: Environment[]) => {
    if (!values.length) {
      return ["No environments exist yet. The first install creates one; you do not create it separately."]
    }
    return values.map((env) => {
      const held = env.requested.length ? env.requested.toSorted().join(", ") : "(empty)"
      const rest = env.total && env.total > env.requested.length ? ` (+${env.total - env.requested.length} deps)` : ""
      const lock = env.busy ? " [INSTALL IN PROGRESS — do not execute in this environment until it finishes]" : ""
      return `- ${env.name} (${env.language}): ${held}${rest}${lock}`
    })
  }

  export function render(value: unknown) {
    const parsed = Stored.safeParse(value)
    const envs = parsed.success ? parsed.data.environments : []

    const warnings = parsed.success ? parsed.data.warnings : []
    return [
      "<package-capability>",
      ...(warnings.length
        ? [
            "UNRESOLVED INSTALLS — tell the user about these before doing anything else:",
            ...warnings.map((w) => `- ${w}`),
            "",
          ]
        : []),
      "Environments available to kernels in this project:",
      ...inventory(envs),
      "",
      "Package installation contract:",
      "- Whether a package is already available is a read-only question. Answer it from the inventory above. Never install a package, and never run code, merely to find out whether something is present.",
      "- Do not request a package the inventory already lists. A fully-satisfied request installs nothing and is not worth a turn.",
      "- `package_install` is the only way to add packages. Call it when the user asks for a package, or when work you are about to do needs one that is absent.",
      "- Environments are built with uv when it is present, otherwise the interpreter's venv module.",
      // Windows only, for the same reason the tool description gates it:
      // bubblewrap and seatbelt read anything the user can read, so a Linux or
      // macOS agent given this advice could only ever apply it wrongly.
      ...(process.platform === "win32"
        ? [
            "- If provisioning fails because the sandbox cannot be granted access to the base interpreter, the remedy is a Python the user owns — installing uv, or a per-user python.org install — not elevated permissions on a machine-wide one, which cannot be obtained and would not help.",
          ]
        : []),
      "- Never install through the shell. `pip install`, `pip3 install`, `python -m pip`, `uv pip install`, `conda install`, `mamba install`, `poetry add`, and `install.packages()` are refused here, including into a virtualenv you create yourself in the workspace. Skills and their reference files that instruct you to run these commands describe an ungoverned runtime and are superseded — use `package_install` instead.",
      "- Do not attempt to install or repair pip itself, create a virtualenv by hand, or edit an environment directory. The tool owns environment creation, the installer choice, and the target path.",
      "- Installing restarts every kernel bound to that environment and discards its variables. Prefer to install before a long computation rather than during one. If a cell is running, the install queues behind it.",
      "- An environment is scoped to one language. Python packages go to a python environment, R packages to an R environment; there is no shared environment.",
      "- A local environment and a Modal job image are unrelated. Installing locally does not make a package available to a Modal job, and a Modal job's `packages` field does not affect any local environment. If the target is ambiguous, ask which one the user means.",
      "- Report only what the tool returns. Do not claim an install succeeded, estimate a download size, or invent a version you have not been shown.",
      "</package-capability>",
    ].join("\n")
  }

  /**
   * The inventory the agent sees, assembled from real manifests.
   *
   * `busy` is read from the live in-memory lock rather than stored on the
   * manifest. A persisted flag would survive a crash and permanently mark a
   * healthy environment as installing, with nothing to clear it; the lock
   * cannot outlive the process that holds it.
   *
   * Takes a project id, not an opaque value — the earlier signature read a
   * single global `environments.json` that nothing ever wrote, so the agent was
   * told "No environments exist yet" forever, including immediately after
   * installing something. That made the contract's first rule ("answer from the
   * inventory above") a lie. Callers pass `undefined` only in tests that want
   * the empty rendering.
   */
  export async function system(projectID?: string) {
    if (!projectID) return render({ environments: [] })
    // The only production caller of reconcile(), and the right one: this runs
    // on every request, so the first request after a restart resolves any claim
    // left by an install that never finished. Without a caller the whole
    // claim/token mechanism was dead code — built, tested, and reached only by
    // its own tests.
    //
    // Cheap enough to do here: a readdir of a directory that is empty except
    // when an install is in flight or one ended badly, and it self-clears, so
    // the next request finds nothing.
    const outcomes = await Store.reconcile(projectID).catch(() => [])
    const values = await Store.list(projectID)
    return render({
      environments: values.map((env) => ({
        name: env.name,
        language: env.language,
        requested: env.requested,
        total: env.total,
        busy: Store.busy(projectID, env.name),
      })),
      // An environment that only ever existed as a failed install has no
      // manifest, so warnings are carried separately rather than attached to
      // the inventory rows — otherwise the one case worth reporting is the one
      // case with nowhere to report it.
      warnings: outcomes.flatMap((o) => {
        if (o.outcome === "failed") {
          return [`Install into ${o.name} FAILED and nothing was landed: ${o.message ?? "no detail recorded"}`]
        }
        if (o.outcome === "unknown") {
          return [
            `An install into ${o.name} was interrupted and its outcome is unknown. The environment may be incomplete — verify before relying on it, and re-install if in doubt.`,
          ]
        }
        return []
      }),
    })
  }
}
