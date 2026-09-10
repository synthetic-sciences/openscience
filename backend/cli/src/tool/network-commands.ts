/**
 * Recognize shell commands that need the network: pushes, fetches, uploads,
 * package installs, direct HTTP. The sandbox denies sockets by default, so
 * these run only after the user approves network access for the destination
 * host, and then with the machine's own publishing credentials.
 */
export namespace NetworkCommands {
  export type Detected = {
    /** Destination hosts, best effort; `git` remotes resolve to a host later. */
    hosts: string[]
    /** Named git remotes whose URL must be read from the repository. */
    remotes: string[]
    /** The individual commands that triggered detection, for the approval card. */
    commands: string[]
  }

  const REGISTRIES: Record<string, string> = {
    npm: "registry.npmjs.org",
    pnpm: "registry.npmjs.org",
    yarn: "registry.yarnpkg.com",
    bun: "registry.npmjs.org",
    pip: "pypi.org",
    pip3: "pypi.org",
    uv: "pypi.org",
    twine: "upload.pypi.org",
    cargo: "crates.io",
    gem: "rubygems.org",
    conda: "conda.anaconda.org",
    mamba: "conda.anaconda.org",
    micromamba: "conda.anaconda.org",
  }

  const REGISTRY_VERBS = new Set(["publish", "install", "add", "ci", "update", "upgrade", "download", "upload", "sync"])
  const GIT_NETWORK = new Set(["push", "fetch", "pull", "clone", "ls-remote"])

  export function hostOf(value: string): string | undefined {
    const url = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+@)?([^/:\s]+)/i.exec(value)
    if (url) return url[2].toLowerCase()
    const scp = /^(?:[\w.-]+@)?([\w.-]+\.[a-z]{2,}):/i.exec(value)
    if (scp) return scp[1].toLowerCase()
    return undefined
  }

  function stripEnv(command: string[]) {
    let index = 0
    while (index < command.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!)) index++
    return command.slice(index)
  }

  /** Inspect one parsed command (the words of a single simple command). */
  export function inspect(input: string[]): Detected | undefined {
    const command = stripEnv(input)
    const name = command[0]?.split("/").pop()
    if (!name) return
    const rest = command.slice(1)
    const flagless = rest.filter((arg) => !arg.startsWith("-"))
    const text = command.join(" ")

    if (name === "git") {
      // Global options such as `-C dir` precede the subcommand.
      const words = rest.filter((arg, index) => !(arg.startsWith("-") || (index > 0 && rest[index - 1] === "-C")))
      const sub = words[0]
      if (!sub) return
      const networked =
        GIT_NETWORK.has(sub) ||
        (sub === "remote" && words[1] === "update") ||
        (sub === "submodule" && (words[1] === "update" || words[1] === "sync")) ||
        (sub === "lfs" && (words[1] === "push" || words[1] === "pull" || words[1] === "fetch"))
      if (!networked) return
      const url = flagless.map(hostOf).find((value): value is string => !!value)
      if (url) return { hosts: [url], remotes: [], commands: [text] }
      if (sub === "clone") return { hosts: [], remotes: [], commands: [text] }
      const remote = words[1] && !words[1].startsWith("-") ? words[1] : "origin"
      return { hosts: [], remotes: [remote], commands: [text] }
    }
    if (name === "gh") return { hosts: ["github.com"], remotes: [], commands: [text] }
    if (name === "hf" || name === "huggingface-cli") return { hosts: ["huggingface.co"], remotes: [], commands: [text] }
    if (name === "docker" || name === "podman") {
      if (rest[0] === "push" || rest[0] === "pull" || rest[0] === "login")
        return { hosts: ["registry-1.docker.io"], remotes: [], commands: [text] }
      return
    }
    if (name in REGISTRIES) {
      const verb = flagless[0]
      const uvRun = name === "uv" && (flagless[0] === "pip" ? flagless[1] : flagless[0])
      if ((verb && REGISTRY_VERBS.has(verb)) || (uvRun && REGISTRY_VERBS.has(uvRun)) || name === "twine")
        return { hosts: [REGISTRIES[name]!], remotes: [], commands: [text] }
      return
    }
    if (name === "curl" || name === "wget" || name === "http" || name === "aria2c") {
      const hosts = flagless.map(hostOf).filter((value): value is string => !!value)
      return { hosts, remotes: [], commands: [text] }
    }
    if (name === "ssh" || name === "scp" || name === "sftp" || name === "rsync") {
      const hosts = flagless
        .map((arg) => hostOf(arg) ?? /^(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+)$/.exec(arg)?.[1]?.toLowerCase())
        .filter((value): value is string => !!value)
      return { hosts, remotes: [], commands: [text] }
    }
    return
  }

  /** Merge detections across every simple command in a script. */
  export function detect(commands: string[][]): Detected | undefined {
    const hits = commands.map(inspect).filter((value): value is Detected => !!value)
    if (hits.length === 0) return
    return {
      hosts: [...new Set(hits.flatMap((hit) => hit.hosts))],
      remotes: [...new Set(hits.flatMap((hit) => hit.remotes))],
      commands: hits.flatMap((hit) => hit.commands),
    }
  }
}
