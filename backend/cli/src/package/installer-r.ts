import fs from "fs/promises"
import { Config } from "../config/config"
import { EgressRuntime } from "../sandbox/egress-runtime"
import { Sandbox } from "../sandbox/sandbox"
import { Installer } from "./installer"

/**
 * The R backend, and the simpler one by a wide margin.
 *
 * There is no ladder to probe and no pip to bootstrap: `install.packages` is
 * part of base R, and the binding is a library path (`R_LIBS_USER`) rather than
 * a per-environment interpreter. `cran.r-project.org` is already in
 * `Egress.DEFAULT_RULES`, so the allowlist needs no change either.
 *
 * Runs under the same sandbox as the Python installer, for the same reason: the
 * install is not more privileged than the kernel that will use it.
 */
export namespace InstallerR {
  /**
   * The package index. A named constant rather than a literal inside the
   * generated R script: it is the one value that decides where packages come
   * from, and a test can assert it by equality instead of grepping this file
   * for a domain — which reads to a static analyser as an incomplete URL check.
   *
   * Already covered by `Egress.DEFAULT_RULES`, so changing it means changing
   * the allowlist too.
   */
  export const REPO = "https://cran.r-project.org"

  /** PEP 503-style normalisation is wrong for CRAN — R package names are
   *  case-sensitive and `.` is meaningful (`data.table`). Compared verbatim. */
  const key = (value: string) => value.trim()

  export async function create(directory: string) {
    await fs.mkdir(Installer.rlibrary(directory), { recursive: true })
  }

  async function confined(directory: string, argv: string[]) {
    const policy = await Config.trustedSandbox()
    const egress = await EgressRuntime.egressFor(policy)
    return Sandbox.wrapArgv({
      file: argv[0]!,
      args: argv.slice(1),
      workspace: [directory],
      options: { ...policy, egress },
    })
  }

  /** `Rscript -e` with the library pinned to the environment. `lib` is passed
   *  explicitly as well as through `R_LIBS_USER`, because `install.packages`
   *  otherwise picks the first writable entry of `.libPaths()` — which on a
   *  machine with a user library already set would be the wrong directory and
   *  would leak this environment's packages into every other project. */
  export async function install(input: { directory: string; packages: string[]; signal?: AbortSignal }) {
    const lib = Installer.rlibrary(input.directory)
    await create(input.directory)
    const names = input.packages.map((p) => JSON.stringify(key(p))).join(", ")
    const script = [
      `lib <- ${JSON.stringify(lib)}`,
      `.libPaths(c(lib, .libPaths()))`,
      `install.packages(c(${names}), lib = lib, repos = ${JSON.stringify(REPO)}, quiet = TRUE)`,
      // install.packages() signals failure with a warning, not a non-zero exit,
      // so a missing package would otherwise look like success.
      `missing <- setdiff(c(${names}), rownames(installed.packages(lib.loc = lib)))`,
      `if (length(missing)) { cat("FAILED:", paste(missing, collapse = ", "), "\\n"); quit(status = 1) }`,
    ].join("\n")
    const spec = await confined(input.directory, ["Rscript", "-e", script])
    const proc = Bun.spawn([spec.file, ...(spec.args ?? [])], {
      env: { ...process.env, ...spec.env, R_LIBS_USER: lib },
      stdout: "pipe",
      stderr: "pipe",
      signal: input.signal,
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    return { ok: proc.exitCode === 0, log: [out, err].filter(Boolean).join("\n") }
  }

  /** name → version for everything in the environment's library. */
  export async function freeze(directory: string) {
    const lib = Installer.rlibrary(directory)
    const script = [
      `ip <- installed.packages(lib.loc = ${JSON.stringify(lib)})`,
      `if (nrow(ip)) cat(paste(rownames(ip), ip[, "Version"], sep = "\\t", collapse = "\\n"))`,
    ].join("\n")
    const proc = Bun.spawn(["Rscript", "-e", script], {
      env: { ...process.env, R_LIBS_USER: lib },
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const [name, version] = line.split("\t")
      if (name && version) out[name.trim()] = version.trim()
    }
    return out
  }

  /** Every package an R kernel bound to this environment can load, system
   *  libraries included — the same distinction `Installer.resolved` draws for
   *  Python, and needed for the same reason: the restart decision is about what
   *  the kernel sees, not what the environment owns. */
  export async function resolved(directory: string) {
    const lib = Installer.rlibrary(directory)
    const script = [
      `ip <- installed.packages()`,
      `if (nrow(ip)) cat(paste(rownames(ip), ip[, "Version"], sep = "\t", collapse = "\n"))`,
    ].join("\n")
    const proc = Bun.spawn(["Rscript", "-e", script], {
      env: { ...process.env, R_LIBS_USER: lib },
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const [name, version] = line.split("\t")
      if (name && version) out[name.trim()] = version.trim()
    }
    return out
  }

  export async function verify(directory: string, packages: string[]) {
    const frozen = await freeze(directory)
    const out: Record<string, string> = {}
    for (const name of packages) {
      const version = frozen[key(name)]
      if (version) out[name] = version
    }
    return out
  }

  /** CRAN's failure text, reduced to the actionable line. Unlike pip there is
   *  no wheels-only concept, so the two surfaces are "no such package" and a
   *  compilation failure naming a system header. */
  export function explain(log: string) {
    const missing = log.match(/^FAILED:\s*(.+)$/m)
    const unavailable = log.match(/package ['‘]([^'’]+)['’] is not available/)
    if (unavailable) {
      return `CRAN has no package named ${unavailable[1]} for this R version. Check the spelling, or whether it lives on Bioconductor rather than CRAN.`
    }
    const fatal = log.match(/^\s*fatal error:\s*(.+)$/m)
    if (fatal) {
      return `An R package failed to compile: ${fatal[1]!.trim()} A sandboxed install cannot add system libraries — prefer a package that ships a binary, or install the system dependency outside OpenScience.`
    }
    if (missing) return `These packages did not install: ${missing[1]!.trim()}\n${log.trim()}`
    return log.trim()
  }
}
