/**
 * Shell-side refusal of package installers.
 *
 * A contract boundary, not a security boundary. The same allowlisted egress
 * that lets `package_install` reach pypi lets a determined agent fetch a wheel
 * by hand, and nothing here stops that. What this buys is that the *normal*
 * path — every skill's `pip install` line, every reference file this repo
 * cannot edit — arrives at the approval card instead of quietly succeeding.
 *
 * It became load-bearing only recently. Before the allowlist proxy, a shell
 * `pip install` died at DNS, so the contract held by accident; measured on
 * `feat/sandbox-network-policy`, `python3 -m venv <workspace>/venv &&
 * <workspace>/venv/bin/pip install tqdm` now succeeds, with no tool and no
 * card. The proxy did not create the intent to bypass, it removed the accident
 * that used to prevent it.
 *
 * Matching is over the tokenised argv `bash.ts` already builds from
 * tree-sitter, not over the raw command line: `echo pip install numpy` is one
 * command whose name is `echo`, and a regex over the line cannot tell the
 * difference.
 */
export namespace Refuse {
  /** Subcommands that mutate an environment. `list`, `show`, `--version` and
   *  friends are read-only questions and stay allowed — refusing them would
   *  break ordinary inspection and teach the agent the tool is unreliable. */
  const mutating = new Set(["install", "add", "uninstall", "remove"])

  /** The last path segment, so `/work/venv/bin/pip` matches `pip`. */
  const leaf = (value: string) => value.split(/[/\\]/).pop() ?? value

  /** `python`, `python3`, `python3.14`, `/usr/bin/python3` — any of which can
   *  carry `-m pip`. */
  const python = (value: string) => /^python[0-9.]*$/.test(leaf(value))

  const message = (packages: string[]) =>
    [
      "Refused: package installation goes through the `package_install` tool, not the shell.",
      packages.length ? `Requested: ${packages.join(", ")}.` : "",
      "Call `package_install` instead — it asks the user for approval, installs into a managed environment, and reports the versions it landed.",
      "This applies to a virtualenv you create yourself in the workspace as well: the environment is the tool's to own.",
    ]
      .filter(Boolean)
      .join(" ")

  /** Operands that look like package names, for the refusal message. Flags and
   *  their values are dropped; so is `-r requirements.txt`. */
  const operands = (rest: string[]) => {
    const values: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      if (arg === "-r" || arg === "--requirement" || arg === "-c" || arg === "--constraint") {
        i++
        continue
      }
      if (arg.startsWith("-")) continue
      values.push(arg)
    }
    return values
  }

  /**
   * A refusal message when `command` is a package-installer invocation,
   * `undefined` otherwise. `command` is the tokenised argv of one command node.
   */
  export function installer(command: string[]): string | undefined {
    const head = command[0]
    if (!head) return undefined
    const name = leaf(head)

    // `python -m pip install ...` / `./venv/bin/python -m pip install ...`
    if (python(head) && command[1] === "-m" && command[2] === "pip") {
      if (!mutating.has(command[3] ?? "")) return undefined
      return message(operands(command.slice(4)))
    }

    // `uv pip install ...`, and also `uv add` / `uv sync` / `uv remove`, which
    // mutate a project environment without going through `uv pip` at all. The
    // previous shape only matched `command[1] === "pip"`, so `uv add tqdm`
    // installed into an ungoverned environment with no approval card and no
    // manifest entry — while the contract injected into every request says uv is
    // refused. Under `network: "allowlist"` the shell now has a working route to
    // pypi.org, which is exactly what makes that gap reachable.
    if (name === "uv") {
      if (command[1] === "pip") {
        if (!mutating.has(command[2] ?? "")) return undefined
        return message(operands(command.slice(3)))
      }
      if (command[1] === "sync") return message([])
      if (!mutating.has(command[1] ?? "")) return undefined
      return message(operands(command.slice(2)))
    }

    // `pip install ...`, `pip3 install ...`, `/work/venv/bin/pip install ...`,
    // and `pipx install ...` — pipx is a distinct tool that the old pattern
    // missed because `pipx` is not `pip` followed by digits or dots.
    if (/^pipx?[0-9.]*$/.test(name)) {
      if (!mutating.has(command[1] ?? "")) return undefined
      return message(operands(command.slice(2)))
    }

    // `conda install ...`, `mamba install ...`
    if (name === "conda" || name === "mamba") {
      if (!mutating.has(command[1] ?? "")) return undefined
      return message(operands(command.slice(2)))
    }

    // `poetry add ...`
    if (name === "poetry") {
      if (!mutating.has(command[1] ?? "")) return undefined
      return message(operands(command.slice(2)))
    }

    // R. There was no branch at all, while `package/prompt.ts` tells the agent
    // `install.packages()` is refused here — so the one language whose installs
    // this feature added support for was the one the refusal did not cover.
    //
    // `Rscript -e 'install.packages("data.table")'` and `R -e ...`: the call is
    // inside a script argument rather than an argv position, so match on the
    // text. `R CMD INSTALL <path>` is the other entry point.
    if (name === "Rscript" || name === "R") {
      if (command[1] === "CMD" && command[2] === "INSTALL") return message(operands(command.slice(3)))
      const script = command.join(" ")
      if (
        /\b(install\.packages|(remotes|devtools|pak)::(install|pkg_install)\w*|BiocManager::install)\s*\(/.test(script)
      ) {
        return message([])
      }
      return undefined
    }

    return undefined
  }
}
