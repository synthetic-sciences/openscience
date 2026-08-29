/**
 * Conservative command-level policy for the user-facing "Ask risky" mode.
 *
 * This is intentionally an allow-list. A sandbox limits where a command can
 * reach, but it does not make destructive changes inside the workspace safe.
 * Commands that can mutate durable state, obscure the command that will run,
 * or fall outside the small audited vocabulary below require approval.
 */
export namespace ShellRisk {
  export type Level = "contained" | "risky"

  export type Result = {
    level: Level
    reason: string
  }

  type Token =
    | {
        kind: "word"
        value: string
      }
    | {
        kind: "operator"
        value: "&&" | "||" | "|" | ";"
      }

  const contained = (reason: string): Result => ({ level: "contained", reason })
  const risky = (reason: string): Result => ({ level: "risky", reason })

  /** Commands whose contract is read-only when shell redirection is absent. */
  const READ_ONLY = new Set([
    "basename",
    "cat",
    "cksum",
    "cmp",
    "comm",
    "cut",
    "df",
    "diff",
    "diff3",
    "dirname",
    "du",
    "false",
    "grep",
    "head",
    "id",
    "jq",
    "ls",
    "lsof",
    "md5",
    "md5sum",
    "otool",
    "ps",
    "pwd",
    "readlink",
    "realpath",
    "rg",
    "stat",
    "strings",
    "tail",
    "test",
    "tree",
    "true",
    "tr",
    "type",
    "uname",
    "wc",
    "which",
    "whoami",
    "[",
    "[[",
  ])

  /** Commands that always cross a durable, remote, process, or system boundary. */
  const MUTATING = new Set([
    "apply_patch",
    "at",
    "aws",
    "az",
    "bash",
    "brew",
    "chflags",
    "chgrp",
    "chmod",
    "chown",
    "cloudflared",
    "conda",
    "cp",
    "createdb",
    "crontab",
    "curl",
    "dash",
    "dd",
    "defaults",
    "diskutil",
    "docker",
    "doctl",
    "doas",
    "dropdb",
    "ed",
    "emacs",
    "eval",
    "ex",
    "exec",
    "fish",
    "flyctl",
    "gh",
    "gcloud",
    "helm",
    "hdiutil",
    "install",
    "kill",
    "killall",
    "kubectl",
    "launchctl",
    "ln",
    "mamba",
    "mkdir",
    "mkfifo",
    "mktemp",
    "modal",
    "mongo",
    "mongosh",
    "mount",
    "mv",
    "mysql",
    "nano",
    "nc",
    "netcat",
    "nice",
    "nohup",
    "open",
    "osascript",
    "patch",
    "perl",
    "pip",
    "pip3",
    "pkill",
    "podman",
    "poweroff",
    "powershell",
    "psql",
    "pulumi",
    "pwsh",
    "python",
    "python3",
    "reboot",
    "redis-cli",
    "renice",
    "rm",
    "rmdir",
    "rsync",
    "ruby",
    "scp",
    "security",
    "service",
    "setfacl",
    "sh",
    "shutdown",
    "sqlite3",
    "ssh",
    "su",
    "sudo",
    "systemctl",
    "tee",
    "terraform",
    "touch",
    "truncate",
    "umount",
    "unlink",
    "uv",
    "vastai",
    "vi",
    "vim",
    "wget",
    "xargs",
    "xattr",
    "zsh",
  ])

  const SAFE_SCRIPTS = new Set(["build", "check", "ci", "lint", "test", "typecheck"])
  const SAFE_MAKE_TARGETS = new Set(["all", ...SAFE_SCRIPTS])
  const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

  /** Validate the same root[:_-]segment language as the former regex without
   * overlapping nested repetitions. Colons delimit non-empty segments; dash
   * and underscore remain valid within a segment for common script names. */
  function safeTarget(value: string, roots: ReadonlySet<string>): boolean {
    const lower = value.toLowerCase()
    const root = [...roots].find((candidate) => lower.startsWith(candidate))
    if (!root) return false
    let index = root.length
    if (index === lower.length) return true

    while (index < lower.length) {
      const separator = lower.charCodeAt(index)
      if (separator !== 45 && separator !== 58 && separator !== 95) return false // -, :, _
      index += 1
      const start = index
      while (index < lower.length) {
        const code = lower.charCodeAt(index)
        const body =
          (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45 || code === 46 || code === 95
        if (!body) break
        index += 1
      }
      if (index === start) return false
    }
    return true
  }

  function executable(value: string) {
    return value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? ""
  }

  function executablePath(value: string) {
    return value.replaceAll("\\", "/")
  }

  function has(args: string[], ...values: string[]) {
    return args.some((arg) => values.includes(arg) || values.some((value) => arg.startsWith(`${value}=`)))
  }

  function lex(source: string): Token[] | Result {
    const tokens: Token[] = []
    let word = ""
    let quote: "single" | "double" | undefined

    const pushWord = () => {
      if (!word) return
      tokens.push({ kind: "word", value: word })
      word = ""
    }
    const pushOperator = (value: Token & { kind: "operator" }) => {
      pushWord()
      const previous = tokens.at(-1)
      if (!previous || previous.kind === "operator") return risky("ambiguous compound shell syntax")
      tokens.push(value)
      return undefined
    }

    for (let i = 0; i < source.length; i++) {
      const char = source[i]
      const next = source[i + 1]

      if (quote === "single") {
        if (char === "'") quote = undefined
        else word += char
        continue
      }
      if (quote === "double") {
        if (char === '"') {
          quote = undefined
          continue
        }
        if (char === "\\") {
          if (next === undefined) return risky("unterminated shell escape")
          word += next
          i++
          continue
        }
        if (char === "`" || (char === "$" && next === "(")) return risky("shell command substitution")
        if (char === "$") return risky("dynamic shell expansion")
        word += char
        continue
      }

      if (char === "'") {
        quote = "single"
        continue
      }
      if (char === '"') {
        quote = "double"
        continue
      }
      if (char === "\\") {
        if (next === undefined) return risky("unterminated shell escape")
        if (next === "\n") {
          i++
          continue
        }
        word += next
        i++
        continue
      }
      if (char === "`" || (char === "$" && next === "(")) return risky("shell command substitution")
      if (char === "$") return risky("dynamic shell expansion")
      if (char === ">" || char === "<") return risky("shell redirection")
      if (char === "(" || char === ")" || char === "{" || char === "}") {
        return risky("ambiguous compound shell syntax")
      }
      if (char === "#" && !word) {
        while (i + 1 < source.length && source[i + 1] !== "\n") i++
        continue
      }
      if (/\s/.test(char)) {
        pushWord()
        if (char === "\n" && tokens.length && tokens.at(-1)?.kind !== "operator") {
          tokens.push({ kind: "operator", value: ";" })
        }
        continue
      }
      if (char === "&") {
        if (next !== "&") return risky("background or ambiguous shell execution")
        const failure = pushOperator({ kind: "operator", value: "&&" })
        if (failure) return failure
        i++
        continue
      }
      if (char === "|") {
        const value = next === "|" ? "||" : "|"
        const failure = pushOperator({ kind: "operator", value })
        if (failure) return failure
        if (next === "|") i++
        continue
      }
      if (char === ";") {
        if (next === ";" || next === "&") return risky("ambiguous compound shell syntax")
        const failure = pushOperator({ kind: "operator", value: ";" })
        if (failure) return failure
        continue
      }
      word += char
    }
    if (quote) return risky("unterminated shell quote")
    pushWord()
    if (!tokens.length || tokens.at(-1)?.kind === "operator") return risky("incomplete shell command")
    return tokens
  }

  function git(args: string[]): Result {
    const globalWithValue = new Set(["-C", "--git-dir", "--work-tree", "--namespace"])
    let index = 0
    while (index < args.length) {
      const arg = args[index]
      const [flag] = arg.split("=", 1)
      if (["-c", "--config-env"].includes(flag)) return risky("git runtime configuration can execute helpers")
      if (globalWithValue.has(flag)) {
        if (!arg.includes("=")) index++
        index++
        continue
      }
      if (["--no-pager", "--paginate", "--literal-pathspecs", "--no-optional-locks"].includes(arg)) {
        index++
        continue
      }
      break
    }
    const command = args[index]?.toLowerCase()
    const rest = args.slice(index + 1)
    if (!command) return risky("git subcommand is missing")
    if (has(rest, "--output")) return risky("git output file mutation")
    if (has(rest, "--ext-diff", "--textconv")) return risky("git external formatter can execute commands")
    if (
      [
        "status",
        "diff",
        "log",
        "show",
        "grep",
        "blame",
        "rev-parse",
        "ls-files",
        "ls-tree",
        "describe",
        "name-rev",
        "shortlog",
      ].includes(command)
    ) {
      return contained(`read-only git ${command}`)
    }
    if (
      command === "branch" &&
      rest.every(
        (arg) =>
          [
            "--show-current",
            "--list",
            "-l",
            "-r",
            "-a",
            "-v",
            "-vv",
            "--contains",
            "--no-contains",
            "--merged",
            "--no-merged",
            "--format",
          ].includes(arg) || arg.startsWith("--format="),
      )
    ) {
      return contained("read-only git branch inspection")
    }
    if (command === "tag" && rest.every((arg) => ["--list", "-l", "-n"].includes(arg) || arg.startsWith("--format="))) {
      return contained("read-only git tag inspection")
    }
    return risky(`git ${command} can mutate repository or remote state`)
  }

  function find(args: string[]): Result {
    if (
      args.some((arg) =>
        ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf"].includes(
          arg.toLowerCase(),
        ),
      )
    ) {
      return risky("find action can mutate or execute commands")
    }
    return contained("read-only file discovery")
  }

  function packageManager(command: string, args: string[]): Result {
    const first = args[0]?.toLowerCase()
    if (first === "test") return contained(`${command} test`)
    if (first === "run" && safeTarget(args[1] ?? "", SAFE_SCRIPTS)) return contained(`${command} local script`)
    if (command === "yarn" && safeTarget(first ?? "", SAFE_SCRIPTS)) return contained("yarn local script")
    return risky(`${command} command is not an audited local test or build`)
  }

  function checker(command: string, args: string[]): Result {
    if (command === "eslint" && has(args, "--fix", "--fix-dry-run")) return risky("eslint fix mutates files")
    if (command === "prettier" && !has(args, "--check")) return risky("prettier without --check can mutate files")
    if (command === "biome" && has(args, "--write", "--fix", "--unsafe")) return risky("biome write mutates files")
    if (command === "tsc" && !has(args, "--noEmit")) return risky("tsc may emit files")
    return contained(`local ${command} check`)
  }

  function buildTool(command: string, args: string[]): Result {
    if (command === "cargo") {
      return ["build", "check", "clippy", "test"].includes(args[0] ?? "") || (args[0] === "fmt" && has(args, "--check"))
        ? contained("local cargo build or test")
        : risky("cargo command is not an audited local test or build")
    }
    if (command === "go") {
      return ["build", "test", "vet"].includes(args[0] ?? "")
        ? contained("local Go build or test")
        : risky("go command is not an audited local test or build")
    }
    if (["make", "gmake"].includes(command)) {
      const targets = args.filter((arg) => !arg.startsWith("-") && !ASSIGNMENT.test(arg))
      return targets.length > 0 && targets.every((target) => safeTarget(target, SAFE_MAKE_TARGETS))
        ? contained("local make build or test")
        : risky("make target is not an audited local test or build")
    }
    if (["gradle", "gradlew", "mvn", "mvnw"].includes(command)) {
      const tasks = args.filter((arg) => !arg.startsWith("-"))
      return tasks.length > 0 && tasks.every((task) => /^(build|check|package|test|verify)$/i.test(task))
        ? contained(`local ${command} build or test`)
        : risky(`${command} task is not an audited local test or build`)
    }
    if (["dotnet", "swift"].includes(command)) {
      return ["build", "test"].includes(args[0] ?? "")
        ? contained(`local ${command} build or test`)
        : risky(`${command} command is not an audited local test or build`)
    }
    if (command === "cmake") {
      return args[0] === "--build" ? contained("local CMake build") : risky("cmake configuration is not read-only")
    }
    if (command === "ninja") {
      const targets = args.filter((arg) => !arg.startsWith("-") && !ASSIGNMENT.test(arg))
      return targets.every((target) => safeTarget(target, SAFE_MAKE_TARGETS))
        ? contained("local ninja build or test")
        : risky("ninja target is not an audited local test or build")
    }
    if (command === "meson") {
      return ["compile", "test"].includes(args[0] ?? "")
        ? contained("local meson build or test")
        : risky("meson command is not an audited local test or build")
    }
    return risky("unknown build command")
  }

  function simple(words: string[]): Result {
    if (!words.length) return risky("environment-only shell command")
    if (ASSIGNMENT.test(words[0])) return risky("shell environment assignment can change execution")
    const source = executablePath(words[0])
    const command = executable(words[0])
    const args = words.slice(1)
    if (!command || command.includes("*") || command.includes("?")) return risky("dynamic or missing executable")
    if (
      source.includes("/") &&
      !source.startsWith("/bin/") &&
      !source.startsWith("/usr/bin/") &&
      !["./gradlew", "./mvnw"].includes(source)
    ) {
      return risky("executable path is outside the audited system or build wrappers")
    }
    if (MUTATING.has(command)) return risky(`${command} crosses a durable or system boundary`)
    if (command === "git") return git(args)
    if (command === "find") return find(args)
    if (["bun", "npm", "pnpm", "yarn"].includes(command)) return packageManager(command, args)
    if (["pytest", "vitest", "jest"].includes(command)) return contained(`local ${command} test`)
    if (["biome", "eslint", "prettier", "tsc"].includes(command)) return checker(command, args)
    if (
      [
        "cargo",
        "cmake",
        "dotnet",
        "gmake",
        "go",
        "gradle",
        "gradlew",
        "make",
        "meson",
        "mvn",
        "mvnw",
        "ninja",
        "swift",
      ].includes(command)
    ) {
      return buildTool(command, args)
    }
    if (command === "sed")
      return has(args, "--in-place") || args.some((arg) => /^-[^-]*i/.test(arg))
        ? risky("sed in-place edit")
        : contained("read-only sed filter")
    if (command === "sort")
      return has(args, "-o", "--output") || args.some((arg) => /^-o.+/.test(arg))
        ? risky("sort output file mutation")
        : contained("read-only sort filter")
    if (command === "unzip")
      return has(args, "-l", "--list") ? contained("archive listing") : risky("archive extraction")
    if (command === "tar") {
      if (
        has(args, "--checkpoint-action", "--to-command", "--use-compress-program") ||
        args.some((arg) => arg === "-I" || arg.startsWith("-I"))
      ) {
        return risky("archive helper can execute another command")
      }
      const mutating = args.some(
        (arg) =>
          ["--append", "--concatenate", "--create", "--delete", "--extract", "--update"].includes(arg) ||
          /^-[^-]*[acdrux]/i.test(arg),
      )
      if (mutating) return risky("archive creation, extraction, or mutation")
      return has(args, "-t", "--list") || args.some((arg) => /^-[^-]*t/i.test(arg))
        ? contained("archive listing")
        : risky("archive operation is not a read-only listing")
    }
    if (command === "date") {
      if (has(args, "-s", "--set") || args.some((arg) => !arg.startsWith("-") && !arg.startsWith("+"))) {
        return risky("date arguments may change system time")
      }
      return contained("read-only date inspection")
    }
    if (command === "hostname") {
      return args.length === 0 || args.every((arg) => ["-d", "-f", "-i", "-s", "--fqdn", "--short"].includes(arg))
        ? contained("read-only hostname inspection")
        : risky("hostname arguments may change system identity")
    }
    if (command === "file") {
      return has(args, "--compile") || args.some((arg) => /^-[^-]*C/.test(arg))
        ? risky("file compilation writes a magic database")
        : contained("read-only file inspection")
    }
    if (command === "cd") return contained("shell-local directory change")
    if (["echo", "printf", ":"].includes(command)) return contained("shell-local output")
    if (command === "command" && args[0] === "-v") return contained("executable lookup")
    if (READ_ONLY.has(command)) return contained(`read-only ${command}`)
    return risky(`unknown command: ${command}`)
  }

  export function classify(source: string): Result {
    const parsed = lex(source.trim())
    if (!Array.isArray(parsed)) return parsed
    let words: string[] = []
    for (const token of parsed) {
      if (token.kind === "word") {
        words.push(token.value)
        continue
      }
      const result = simple(words)
      if (result.level === "risky") return result
      words = []
    }
    const result = simple(words)
    if (result.level === "risky") return result
    return contained("all shell commands are audited local reads, tests, or builds")
  }
}
