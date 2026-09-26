import path from "path"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import type { Hooks, Plugin } from "@synsci/plugin"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { PermissionNext } from "@/permission/next"
import { ProjectAccess } from "@/project/access"
import { BashTool } from "@/tool/bash"
import { HarnessState } from "./state"
import { Deliverables } from "./deliverables"
import { iife } from "@synsci/util/iife"

/**
 * The verification contract a request states for itself, run before a turn
 * may end. "Your proof must compile with `lake build GSLean`", "the tests in
 * `tests/` must pass: `pytest -q`", "avoid `sorry` and `admit` anywhere under
 * `src/`" are the grader's own instrument, and a run that ends with them
 * failing has not finished. The deliverables unit sees whether files exist;
 * this unit sees whether they pass. Nothing here is task-specific: the
 * commands and tokens are read from the first request, only recognised
 * verifier commands are run, and the model is told the result verbatim.
 */
export namespace Acceptance {
  export type Command = { command: string; cwd?: string }
  export type Banned = { tokens: string[]; scope: string }
  export type Contract = { commands: Command[]; banned: Banned[] }

  /** Verifier commands worth running unattended: builds, test runners, the
   * checkers a task ships. Anything else in backticks is not a check. */
  const VERIFIER =
    /^(?:lake (?:build|env lean|exe)\b|lean\b|pytest\b|python3? -m (?:pytest|unittest)\b|make(?: [\w.-]+)*$|make (?:test|check|verify|build)\b|cargo (?:test|build|check)\b|npm (?:test|run (?:test|check|verify|build))\b|pnpm (?:test|run \w+)\b|go (?:test|build|vet)\b|coqc\b|coqchk\b|coq_makefile\b|ctest\b|dune (?:build|test)\b|stack (?:build|test)\b|cabal (?:build|test)\b|(?:ba)?sh [\w./-]+\.sh\b|\.\/[\w./-]+\.(?:sh|py)\b|python3? [\w./-]*(?:check|verif|valid|test|grade|eval)[\w./-]*\.py\b|node [\w./-]*(?:check|verif|valid|test)[\w./-]*\.[cm]?js\b|Rscript [\w./-]+\.R\b|julia [\w./-]+\.jl\b)/

  const COMPILER = /^(?:g\+\+|gcc|clang\+\+|clang|cc|c\+\+|javac|rustc|ghc|nvcc|gfortran)(?=\s|$)/

  /** A sentence that presents a command as a requirement, not as an example
   * of usage. */
  const REQUIRED =
    /\b(?:must|should|needs? to|has to|required to|is required|are required|expected to)\s+(?:compile|build|pass|run|succeed|type-?check|verify|validate)|\b(?:compile|build|pass|run|succeed|type-?check|verify|validate)\b[^`\n]{0,60}(?:with|using|via|by running|by)\s*`|\b(?:run|execute)\s+`|`[^`\n]+`\s*(?:must|should)\s+(?:pass|succeed|compile|exit)|(?:passes|succeeds|compiles|exits (?:with )?0)\b/i

  /** A sentence that forbids tokens: "avoid", "banned", "must not use", "may
   * not contain", "disallowed". */
  const FORBIDS =
    /\b(?:avoid|banned|forbidden|disallowed|prohibited|not allowed|must not (?:use|contain|appear|include)|may not (?:use|contain|appear|include)|do not use|never use|without using)\b/i

  /** A scope for banned tokens: "anywhere under `/task/src/`", "in
   * `GSLean/`", "under the `proofs` directory". */
  const SCOPE =
    /\b(?:anywhere\s+)?(?:under|in|inside|within|throughout)\s+(?:`([^`\n]+)`|(\/[\w.@-]+(?:\/[\w.@-]+)*)\/?(?=[\s.,;:)]|$))/i
  /** The path a SCOPE match names, whichever spelling it used. */
  const scopeOf = (match: RegExpMatchArray | null | undefined) => match?.[1] ?? match?.[2]

  /** "(run from `/task/`)", "from the `/app` directory". */
  const FROM = /\b(?:run|executed?|invoked?)\s+(?:from|in|inside)\s+`([^`\n]+)`|\bfrom\s+`(\/[^`\n]+)`/i

  const TOKEN = /^[\w@#.\[\]:'-]{1,40}$/

  export function detect(text: string): Contract {
    const prose = text.replace(/^\s*(?:```|~~~)[^\n]*\n[\s\S]*?^\s*(?:```|~~~)[^\n]*$/gm, "")
    const commands = new Map<string, Command>()
    const banned: Banned[] = []
    const sentences = prose.split(/(?<=[.!?;])\s+|\n+/)
    for (const [index, sentence] of sentences.entries()) {
      // "The completed project must compile with:" and the command alone on
      // the next line: the requirement and its command are one statement.
      const spans = [...sentence.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim())
      const next = sentences[index + 1]?.trim() ?? ""
      if (!spans.length && /:\s*$/.test(sentence) && REQUIRED.test(sentence) && /^`[^`\n]+`$/.test(next)) {
        spans.push(next.slice(1, -1).trim())
      }
      if (!spans.length) continue
      if (REQUIRED.test(sentence)) {
        const cwd = sentence
          .match(FROM)
          ?.slice(1)
          .find((value) => !!value)
        for (const span of spans) {
          if (span.length > 200) continue
          // A compiler line is a check only when it names what to compile:
          // "compiles solution.cpp with `g++ -O3 -I/app`" gives flags, and
          // running the flags alone would fail for the wrong reason.
          const compiler = COMPILER.test(span) && /\S+\.(?:cpp|cc|cxx|c|rs|java|hs|cu|f90|f)\b/.test(span)
          if (!VERIFIER.test(span) && !compiler) continue
          if (!commands.has(span))
            commands.set(span, { command: span, ...(cwd ? { cwd: cwd.replace(/\/$/, "") || "/" } : {}) })
        }
      }
      if (FORBIDS.test(sentence)) {
        const scope = scopeOf(sentence.match(SCOPE))
        const tokens = spans.filter((span) => TOKEN.test(span) && span !== scope && !/[\/\s]/.test(span))
        if (scope && tokens.length) banned.push({ tokens: [...new Set(tokens)], scope: scope.replace(/\/$/, "") })
      }
    }
    for (const extra of listed(prose)) {
      if (banned.some((entry) => entry.scope === extra.scope)) continue
      banned.push(extra)
    }
    return { commands: [...commands.values()], banned }
  }

  /** Bans the sentence pass cannot see, because the prose is wrapped across
   * lines or the tokens sit in bullets under a line ending in a colon: "the
   * following are not allowed anywhere under that subtree:" followed by
   * `- **Proof escapes:** \`sorry\`, \`admit\`, …", or "the submitted file must
   * not invoke \`scipy.optimize\` or …" whose file is named earlier in the
   * paragraph. The scope is the nearest path the paragraph names; a token the
   * request also uses where it forbids nothing (the objective a solver must
   * call, a name the statement uses) is left out, and a bullet only counts
   * when it is mostly a list of names. */
  const INVOKES =
    /\b(?:must not|may not|do not|cannot|never)\s+(?:invoke|import|call|load|depend on)\b|\bnot allowed\b|\bare forbidden\b|\bare banned\b|\bare prohibited\b/i
  /** "it provides only \`numpy\` and \`scipy\`, so it must not import any other
   * package": the names are what is allowed. */
  const ALLOWLIST =
    /\b(?:any other|every other|other than|except|apart from|besides|anything else|nothing else|only)\b/i
  const PATHLIKE = /^(?:\/[\w.@-]+(?:\/[\w.@-]*)*|[\w.-]+\/[\w./-]*|[\w-]+\.(?:py|lean|R|jl|rs|cpp|c|js|ts|v|hs|ml|m))$/
  /** "Banned: SciPy, Numba, Cython, PyTorch, JAX, CuPy, …": product names
   * without backticks after a label. Each becomes the name it is imported by
   * (lower case; the few products whose import differs from their name are
   * mapped), and only single words are taken: "C/FFI extensions" and
   * "numpy.linalg dense solvers (solve, inv, …)" are descriptions the model
   * reads, not tokens a grep can check. */
  const LABELLED = /\b(?:\*\*)?(?:Banned|Forbidden|Disallowed|Prohibited|Not allowed)(?:\*\*)?:\s*(.+)$/m
  const IMPORT_NAME: Record<string, string> = {
    pytorch: "torch",
    "scikit-learn": "sklearn",
    sklearn: "sklearn",
    opencv: "cv2",
    pillow: "PIL",
    petsc: "petsc4py",
    beautifulsoup: "bs4",
  }
  function labelled(paragraph: string): string[] {
    const match = paragraph.match(LABELLED)
    if (!match) return []
    // The list ends at the first full stop, semicolon or parenthesis; "and"
    // joins the last item. What a parenthesis explains ("dense solvers
    // (solve, inv, …)") are calls the model reads about, not import names.
    const list = match[1].split(/\(|(?<=[a-z\]])[.;]\s|[.;]$/i)[0]
    return list
      .split(/,\s*|\s+and\s+/i)
      .map((item) => item.trim().replace(/^and\s+/i, ""))
      .filter((item) => /^[A-Za-z][\w-]{1,24}$/.test(item))
      .map((item) => IMPORT_NAME[item.toLowerCase()] ?? item.toLowerCase())
  }

  function listed(prose: string): Banned[] {
    const lines = prose.split("\n")
    const bullet = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)
    const paragraphs: string[][] = []
    let current: string[] = []
    for (const line of lines) {
      if (!line.trim()) {
        if (current.length) paragraphs.push(current)
        current = []
        continue
      }
      current.push(line)
    }
    if (current.length) paragraphs.push(current)
    const spans = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim())
    // The lines of a paragraph that are prose: not a bullet, and not the
    // indented continuation of one (a wrapped bullet's second line is still
    // the bullet, not a sentence that permits its names).
    const proseLines = (paragraph: string[]) => {
      const out: string[] = []
      let inBullet = false
      for (const line of paragraph) {
        if (bullet(line)) inBullet = true
        else if (inBullet && /^\s+\S/.test(line)) continue
        else inBullet = false
        if (!inBullet) out.push(line)
      }
      return out
    }
    // Every sentence of the request that forbids nothing: where a token also
    // appears there, it is part of the interface, not a ban.
    const permitted = new Set(
      paragraphs
        .flatMap((paragraph) =>
          proseLines(paragraph)
            .join(" ")
            .split(/(?<=[.!?;:])\s+/),
        )
        .filter((sentence) => !FORBIDS.test(sentence) && !INVOKES.test(sentence))
        .flatMap(spans),
    )
    const scopeIn = (text: string) => {
      const explicit = [...text.matchAll(new RegExp(SCOPE.source, "gi"))].map((match) => scopeOf(match)!)
      const named = spans(text).filter((span) => PATHLIKE.test(span))
      return (explicit.at(-1) ?? named.at(-1))?.replace(/\/$/, "")
    }
    const clean = (tokens: string[], scope: string) =>
      [...new Set(tokens)].filter(
        (token) =>
          TOKEN.test(token) &&
          token !== scope &&
          !/[\/\s]/.test(token) &&
          !permitted.has(token) &&
          !PATHLIKE.test(token),
      )
    const out: Banned[] = []
    // A bullet wrapped across lines is one item: its continuation lines are
    // indented and are not bullets themselves.
    const items = (lines: string[]) => {
      const out: string[] = []
      for (const line of lines) {
        if (bullet(line)) out.push(line)
        else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += " " + line.trim()
        else break
      }
      return out
    }
    // A blank line may separate a colon-ended lead-in from its bullets: the
    // bullets that open the next paragraph belong to it.
    const following = (at: number) => {
      const next = paragraphs[at + 1] ?? []
      return next.length && bullet(next[0]) ? next : []
    }
    // A ban list that names no place applies to what the request has the
    // model write: when that is one file (a proof's `Basic.lean`), the list
    // is checked in that file. A directory would sweep in the pinned files
    // beside it, whose own `notation` or `syntax` is not the model's to fix.
    const single = iife(() => {
      const files = Deliverables.detect(prose).filter((name) => /\.\w{1,6}$/.test(name))
      return files.length === 1 ? files[0] : undefined
    })
    for (const [at, paragraph] of paragraphs.entries()) {
      const text = paragraph.join(" ")
      const named = labelled(text)
      if (named.length) {
        const scope = scopeIn(text)
        if (scope) {
          const kept = clean(named, scope)
          if (kept.length) out.push({ tokens: kept, scope })
        }
      }
      for (const [index, line] of paragraph.entries()) {
        // The sentence that ends in the colon, however many lines it wraps
        // across: "…mechanisms that could redefine the verifier's language
        // are not\nallowed:" forbids, though its last line alone does not.
        const lead = paragraph
          .slice(0, index + 1)
          .join(" ")
          .split(/(?<=[.!?;])\s+/)
          .at(-1)!
        const forbidding = FORBIDS.test(lead) || INVOKES.test(lead)
        // A colon-ended forbidding line owns the bullets that follow it.
        if (
          forbidding &&
          /:\s*(?:\*\*)?\s*$/.test(line) &&
          !ALLOWLIST.test(lead.slice(lead.search(INVOKES) >= 0 ? lead.search(INVOKES) : lead.search(FORBIDS)))
        ) {
          const scope = scopeIn(paragraph.slice(0, index + 1).join(" ")) ?? single
          if (!scope) continue
          const tokens: string[] = []
          for (const item of items(index + 1 < paragraph.length ? paragraph.slice(index + 1) : following(at))) {
            const names = spans(item)
            const rest = item
              .replace(/`[^`\n]+`/g, "")
              .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*[^*]+\*\*:?)?/, "")
              .split(/\s+/)
              .filter((word) => /[A-Za-z]{3,}/.test(word))
            // Mostly names: "custom syntax or elaboration through `macro`,
            // `macro_rules`, `elab`, `elab_rules`, `syntax`, …" still counts.
            if (names.length >= 3 && rest.length <= Math.max(8, 2 * names.length)) tokens.push(...names)
          }
          const kept = clean(tokens, scope)
          if (kept.length) out.push({ tokens: kept, scope })
        }
      }
      // A wrapped forbidding sentence: join the paragraph's prose lines and
      // look again, with the scope taken from the paragraph.
      const joined = proseLines(paragraph).join(" ")
      for (const sentence of joined.split(/(?<=[.!?;])\s+/)) {
        if (!INVOKES.test(sentence) || ALLOWLIST.test(sentence)) continue
        const names = spans(sentence)
        if (!names.length) continue
        const scope =
          scopeOf(sentence.match(SCOPE))?.replace(/\/$/, "") ?? scopeIn(joined.slice(0, joined.indexOf(sentence)))
        if (!scope) continue
        const kept = clean(names, scope)
        if (kept.length) out.push({ tokens: kept, scope })
      }
    }
    return out
  }

  export function envLine(contract: Contract) {
    const parts = [
      ...contract.commands.map((entry) => `\`${entry.command}\`${entry.cwd ? ` (from ${entry.cwd})` : ""} must pass`),
      ...contract.banned.map(
        (entry) => `no ${entry.tokens.map((token) => `\`${token}\``).join(", ")} under ${entry.scope}`,
      ),
    ]
    return parts.length ? [`Acceptance (checked before the run ends): ${parts.join("; ")}`] : []
  }

  export type Failure = { what: string; detail: string }

  /** Run one command in its directory with a bounded wait; the tail of its
   * combined output is what the model reads. */
  /** The file that marks a build tool's project root. A command the request
   * states without a directory ("must compile with `lake build --wfail`")
   * runs where its project is, not at the workspace root, when exactly one
   * such project sits beneath the root. */
  const MARKERS: [RegExp, string[]][] = [
    [/^lake\b/, ["lakefile.lean", "lakefile.toml"]],
    [/^cargo\b/, ["Cargo.toml"]],
    [/^(?:npm|pnpm)\b/, ["package.json"]],
    [/^make\b/, ["Makefile", "makefile", "GNUmakefile"]],
    [/^dune\b/, ["dune-project"]],
    [/^go\b/, ["go.mod"]],
    [/^(?:stack|cabal)\b/, ["stack.yaml", "cabal.project"]],
  ]

  async function projectDir(command: string, root: string) {
    const markers = MARKERS.find(([tool]) => tool.test(command))?.[1]
    if (!markers) return root
    const has = async (dir: string) =>
      (await Promise.all(markers.map((name) => fs.stat(path.join(dir, name)).catch(() => undefined)))).some(Boolean)
    if (await has(root)) return root
    const found: string[] = []
    const search = async (dir: string, depth: number) => {
      if (depth > 3 || found.length > 1) return
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        const full = path.join(dir, entry.name)
        if (await has(full)) found.push(full)
        else await search(full, depth + 1)
      }
    }
    await search(root, 0)
    return found.length === 1 ? found[0] : root
  }

  /** What running a check yields: the exit code (null when it was killed),
   * whether the time ran out, and the output the grader would read. */
  export type Outcome = { exit: number | null; timedOut: boolean; output: string }
  export type Executor = (command: string, cwd: string, timeoutMs: number) => Promise<Outcome>

  /** A plain shell, for a check run outside a session: unit tests, a script.
   * The shell leads its own process group, so a timeout ends the command it
   * spawned as well: a `sh -c 'sleep …'` that dash does not exec would
   * otherwise outlive its shell holding the output pipes open. */
  export const shell: Executor = (command, cwd, timeoutMs) =>
    new Promise((resolve, reject) => {
      const detached = process.platform !== "win32"
      const child = spawn("sh", ["-lc", command], {
        cwd,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached,
      })
      const chunks: Buffer[] = []
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk))
      let timedOut = false
      const kill = () => {
        if (detached && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL")
            return
          } catch {}
        }
        child.kill("SIGKILL")
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", (code) => {
        clearTimeout(timer)
        resolve({ exit: code, timedOut, output: Buffer.concat(chunks).toString().trim() })
      })
    })

  /** The session's own bash tool: the check runs as a command the model had
   * typed would, under the same permission rule and card, inside the same
   * sandbox, with the same credential sanitising and provenance. A request's
   * stated check is no licence to run a shell the project's rules would not
   * give the model. A denied permission is a check that did not run. */
  export async function tooled(sessionID: string): Promise<Executor> {
    const session = await Session.get(sessionID)
    const newest = await iife(async () => {
      for await (const message of MessageV2.stream(sessionID)) {
        if (message.info.role === "user") return message
      }
    })
    const agent = await Agent.get(newest?.info.role === "user" ? newest.info.agent : "research")
    if (!agent) throw new Error("The session's agent is not registered")
    const bash = await BashTool.init({ agent })
    const messages = await Array.fromAsync(MessageV2.stream(sessionID))
    return async (command, cwd, timeoutMs) => {
      const result = await bash.execute(
        { command, workdir: cwd, timeout: timeoutMs, description: "Acceptance check the request states" },
        {
          sessionID,
          messageID: newest?.info.id ?? "",
          callID: `acceptance-${Date.now().toString(36)}`,
          agent: agent.name,
          abort: new AbortController().signal,
          messages,
          metadata() {},
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID,
              mode: (await ProjectAccess.status(Instance.project)).mode,
              ruleset: PermissionNext.merge(agent.permission, session.permission ?? []),
            })
          },
        },
      )
      const exit = typeof result.metadata.exit === "number" ? result.metadata.exit : null
      return {
        exit,
        timedOut: result.output.includes("terminated command after exceeding timeout"),
        output: result.output.replace(/\n*<bash_metadata>[\s\S]*<\/bash_metadata>\s*$/, "").trim(),
      }
    }
  }

  export async function run(
    entry: Command,
    root: string,
    timeoutMs: number,
    execute: Executor = shell,
  ): Promise<Failure | undefined> {
    const cwd = entry.cwd
      ? path.isAbsolute(entry.cwd)
        ? entry.cwd
        : path.join(root, entry.cwd)
      : await projectDir(entry.command, root)
    const exists = await fs
      .stat(cwd)
      .then((info) => info.isDirectory())
      .catch(() => false)
    if (!exists) return { what: `\`${entry.command}\``, detail: `its directory ${cwd} does not exist` }
    const outcome = await execute(entry.command, cwd, timeoutMs).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
    if ("error" in outcome) {
      // Denied or refused: the check has not passed, and the reason is the
      // rule that stopped it, not the code under test.
      return { what: `\`${entry.command}\` (in ${cwd})`, detail: `could not be run here: ${outcome.error}` }
    }
    if (outcome.exit === 0 && !outcome.timedOut) return
    const tail = outcome.output.split("\n").slice(-25).join("\n").slice(-3000)
    const reason = outcome.timedOut
      ? `did not finish within ${Math.round(timeoutMs / 60000)} minutes`
      : `exited with code ${outcome.exit}`
    return {
      what: `\`${entry.command}\` (in ${cwd})`,
      detail: `${reason}${tail ? `. Output ends with:\n${tail}` : ""}`,
    }
  }

  /** Every occurrence of a banned token as a whole word under the scope,
   * as file:line, skipping build output and hidden directories. */
  export async function grep(entry: Banned, root: string): Promise<Failure | undefined> {
    const scope = path.isAbsolute(entry.scope) ? entry.scope : path.join(root, entry.scope)
    const info = await fs.stat(scope).catch(() => undefined)
    if (!info) return { what: `banned tokens under ${scope}`, detail: "the directory does not exist" }
    const files = info.isDirectory() ? await walk(scope) : [scope]
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const patterns = entry.tokens.map((token) => {
      const plain = `(?<![\\w.])${escape(token)}(?![\\w])`
      // `scipy.optimize` is also imported as `from scipy import optimize`.
      const parts = token.split(".")
      const dotted = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(token)
        ? `|^\\s*from\\s+${escape(parts.slice(0, -1).join("."))}\\s+import\\s+[^#\\n]*\\b${escape(parts.at(-1)!)}\\b`
        : ""
      return { token, regex: new RegExp(plain + dotted) }
    })
    const hits: string[] = []
    for (const file of files) {
      const text = await Bun.file(file)
        .text()
        .catch(() => "")
      // A binary file is not where a banned keyword lives.
      if (!text || text.includes("\u0000")) continue
      const lines = text.split("\n")
      for (const [index, line] of lines.entries()) {
        for (const { token, regex } of patterns) {
          if (regex.test(line)) hits.push(`${path.relative(root, file)}:${index + 1}: \`${token}\``)
        }
        if (hits.length >= 20) break
      }
      if (hits.length >= 20) break
    }
    if (!hits.length) return
    return { what: `banned tokens under ${entry.scope}`, detail: `found:\n${hits.join("\n")}` }
  }

  /** Directories a grader's recursive grep would also skip: build output and
   * dependency trees. Hidden files and unknown extensions are scanned: a
   * leftover temp file beside a proof is exactly what such a grep finds. */
  const SKIP_DIRS = new Set([
    "node_modules",
    "build",
    "_build",
    "target",
    ".lake",
    ".git",
    "__pycache__",
    ".venv",
    "venv",
  ])

  async function walk(dir: string, depth = 0): Promise<string[]> {
    if (depth > 6) return []
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const out: string[] = []
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await walk(full, depth + 1)))
      else if (entry.isFile()) {
        const size = await fs
          .stat(full)
          .then((info) => info.size)
          .catch(() => 0)
        if (size > 0 && size <= 2_000_000) out.push(full)
      }
      if (out.length > 2000) break
    }
    return out
  }

  export function render(failures: Failure[]) {
    return [
      "Before finishing, the acceptance checks the request states were run as the grader will run them. These fail:",
      ...failures.map((failure) => `- ${failure.what}: ${failure.detail}`),
      "Fix the cause and run the check again before finishing; if it cannot pass, say precisely what fails and why.",
    ].join("\n")
  }

  export const TIMEOUT_MS = 15 * 60_000
}

export const AcceptanceUnit: Plugin = async () => {
  const hooks: Hooks = {
    async "chat.message"(input, output) {
      const state = HarnessState.get(input.sessionID)
      if (state.acceptance.commands.length || state.acceptance.banned.length) return
      const session = await Session.get(input.sessionID).catch(() => undefined)
      if (session?.parentID) return
      const spoken = output.parts.filter(
        (part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic,
      )
      if (!spoken.length) return
      const earlier = (await Session.messages({ sessionID: input.sessionID }).catch(() => [])).filter(
        (message) =>
          message.info.role === "user" &&
          message.info.id !== output.message.id &&
          message.info.internal?.type !== "continuation" &&
          message.parts.some((part) => part.type === "text" && !part.synthetic),
      )
      if (earlier.length) return
      state.acceptance = Acceptance.detect(spoken.map((part) => part.text).join("\n"))
    },
    async "env.lines"(input, output) {
      output.lines.push(...Acceptance.envLine(HarnessState.get(input.sessionID).acceptance))
    },
    async "loop.before_finish"(input, output) {
      const state = HarnessState.get(input.sessionID)
      const contract = state.acceptance
      if (!contract.commands.length && !contract.banned.length) return
      const root = Instance.directory
      const execute = await Acceptance.tooled(input.sessionID).catch(() => undefined)
      const results = await Promise.all([
        ...contract.commands.map((entry) =>
          execute
            ? Acceptance.run(entry, root, Acceptance.TIMEOUT_MS, execute)
            : { what: `\`${entry.command}\``, detail: "could not be run: the session has no shell to run it in" },
        ),
        ...contract.banned.map((entry) => Acceptance.grep(entry, root)),
      ])
      const failures = results.filter((result): result is Acceptance.Failure => !!result)
      state.acceptanceFailing = failures.length > 0
      // The deliverables unit may already be speaking about missing files;
      // its message stands, and the checks run again on the next finish.
      if (!failures.length || output.message || state.acceptanceRounds >= 3) return
      state.acceptanceRounds++
      output.message = Acceptance.render(failures)
    },
    async event({ event }) {
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
    },
  }
  return hooks
}
