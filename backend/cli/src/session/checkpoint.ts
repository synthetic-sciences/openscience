import fs from "node:fs/promises"
import path from "node:path"
import { OpenScience } from "@/openscience"
import { Instance } from "@/project/instance"
import { Vcs } from "@/project/vcs"
import { Session } from "."
import { SessionTrace } from "./trace"
import { Todo } from "./todo"

export namespace SessionCheckpoint {
  const clip = (value: string, size = 2_000) => (value.length <= size ? value : `${value.slice(0, size)}…`)

  const clean = (value: string) => value.trim().replace(/\s+/g, " ")

  const slug = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)

  async function git(args: string[]) {
    if (Instance.project.vcs !== "git") return undefined
    const proc = Bun.spawn(["git", ...args], {
      cwd: Instance.worktree,
      stdout: "pipe",
      stderr: "ignore",
    })
    const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return undefined
    return output.trim()
  }

  async function ignore(dir: string) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, ".gitignore")
    const content = await Bun.file(file)
      .text()
      .catch(() => "")
    if (content.split(/\r?\n/).includes("*")) return
    const prefix = content.length === 0 || content.endsWith("\n") ? content : `${content}\n`
    await fs.writeFile(file, `${prefix}*\n`, { mode: 0o600 })
  }

  function section(title: string, rows: string[], empty = "None recorded") {
    return [`## ${title}`, "", ...(rows.length > 0 ? rows : [empty]), ""]
  }

  export async function create(input: { sessionID: string; label?: string }) {
    const [session, messages, todos, trace, branch, commit, status] = await Promise.all([
      Session.get(input.sessionID),
      Session.messages({ sessionID: input.sessionID }),
      Todo.get(input.sessionID),
      SessionTrace.build(input.sessionID),
      Vcs.branch(),
      git(["rev-parse", "HEAD"]),
      git(["status", "--porcelain=v1", "--untracked-files=normal"]),
    ])
    const request = messages
      .filter((message) => message.info.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" && !part.ignored && !part.synthetic && part.text.trim() ? [part.text] : [],
        ),
      )[0]
    const objective = trace.research.contract?.objective ?? (request ? clean(clip(request)) : session.title)
    const dirty = status === undefined ? "unknown" : status.length > 0 ? "yes" : "no"
    const next =
      todos.find((todo) => todo.status === "in_progress")?.content ??
      todos.find((todo) => todo.status === "pending")?.content ??
      trace.research.contract?.stages.find((stage) => stage.status === "running")?.label ??
      trace.research.contract?.stages.find((stage) => stage.status === "pending")?.label ??
      trace.research.missing[0] ??
      "Inspect this checkpoint and select the next evidence-backed action."
    const activeTools = trace.tools.filter((tool) => tool.status === "pending" || tool.status === "running")
    const activeJobs = trace.jobs.filter((job) => job.status === "queued" || job.status === "running")
    const activeKernels = trace.kernels.filter((kernel) => kernel.status === "pending" || kernel.status === "running")
    const inference = trace.inference.at(-1)
    const unknown = [
      ...activeTools.map((tool) => `- Tool outcome may be unknown: \`${tool.name}\` (${tool.callID}, ${tool.status})`),
      ...activeJobs.map((job) => `- Compute outcome may be unknown: \`${job.name}\` (${job.id}, ${job.status})`),
      ...activeKernels.map(
        (kernel) =>
          `- ${kernel.language.toUpperCase()} kernel outcome may be unknown: ${kernel.toolID} (${kernel.status})`,
      ),
    ]
    const contract = trace.research.contract
    const lines = [
      "# OpenScience recovery checkpoint",
      "",
      `- Session: ${session.title} (\`${session.id}\`)`,
      `- Captured: ${new Date().toISOString()}`,
      `- Session state: ${trace.session.status}`,
      `- Readiness: ${trace.research.status} (${trace.research.readiness}%)`,
      "",
      ...section("Objective", [objective]),
      ...section("Git state", [
        `- Branch: ${branch ? `\`${branch}\`` : "unavailable"}`,
        `- Commit: ${commit ? `\`${commit}\`` : "unavailable"}`,
        `- Dirty: ${dirty}`,
        ...(status ? status.split("\n").map((item) => `- \`${item}\``) : []),
      ]),
      ...section(
        "Plan",
        todos.map((todo) => `- [${todo.status === "completed" ? "x" : " "}] ${todo.content} (${todo.status})`),
      ),
      ...section(
        "Research stages",
        contract?.stages.map(
          (stage) => `- ${stage.label}: **${stage.status}**${stage.detail ? ` — ${clean(stage.detail)}` : ""}`,
        ) ?? [],
        contract ? "No stages recorded" : "No research contract defined",
      ),
      ...section(
        "Verification checks",
        contract?.checks.map(
          (check) =>
            `- ${check.label}: **${check.status}**${check.evidence ? ` — ${clean(clip(check.evidence, 500))}` : ""}`,
        ) ?? [],
      ),
      ...section(
        "Required Results",
        contract?.deliverables.map(
          (item) => `- \`${item.path}\`: ${item.label}${item.required ? " (required)" : " (optional)"}`,
        ) ?? [],
      ),
      ...section(
        "Saved artifacts",
        trace.artifacts.map(
          (artifact) =>
            `- ${artifact.path ? `\`${artifact.path}\`` : (artifact.artifactID ?? artifact.toolID)}${artifact.versionID ? ` (version ${artifact.versionID})` : ""}${artifact.sha256 ? ` — sha256 \`${artifact.sha256}\`` : ""}`,
        ),
      ),
      ...section("Inference and harness", [
        ...(inference
          ? [
              `- Last inference: ${inference.provider}/${inference.model} via ${inference.source} (${inference.agent}, effort ${inference.effort})`,
            ]
          : ["- No model inference recorded"]),
        `- Harness records: ${trace.harnessReport.records}; fingerprints: ${trace.harnessReport.fingerprints.length}; stable: ${trace.harnessReport.stable ? "yes" : "no"}; valid: ${trace.harnessReport.valid ? "yes" : "no"}`,
        ...trace.harnessReport.checks.map(
          (check) =>
            `- ${check.id}: **${check.status}**${check.affected.length ? ` — affected ${check.affected.join(", ")}` : ""}`,
        ),
      ]),
      ...section("Runtime ledger", [
        ...trace.jobs.map(
          (job) =>
            `- Job \`${job.name}\` (${job.id}): ${job.status}${job.exitCode !== undefined && job.exitCode !== null ? `, exit ${job.exitCode}` : ""}; target ${job.targetLabel}; artifacts ${job.artifactCount}`,
        ),
        ...trace.kernels.map(
          (kernel) =>
            `- ${kernel.language.toUpperCase()} kernel ${kernel.toolID}: ${kernel.status}${kernel.executionCount !== undefined ? `, execution ${kernel.executionCount}` : ""}`,
        ),
        ...trace.tools
          .slice(-20)
          .map(
            (tool) =>
              `- Tool \`${tool.name}\` (${tool.callID}): ${tool.status}${tool.title ? ` — ${clean(tool.title)}` : ""}`,
          ),
      ]),
      ...section("Recorded failures", [
        ...(contract?.failures.map(
          (failure) =>
            `- ${failure.stage} / ${failure.candidate}: ${clean(clip(failure.message, 700))}${failure.disposition ? ` — ${clean(failure.disposition)}` : ""}`,
        ) ?? []),
        ...trace.failures.map((failure) => `- ${failure.kind} ${failure.id}: ${clean(clip(failure.message, 700))}`),
      ]),
      ...section(
        "Reviewer findings",
        trace.reviewerFindings.map(
          (finding) =>
            `- ${finding.severity ?? "unrated"} ${finding.status ?? "open"}: ${clean(clip(finding.issue ?? finding.claim ?? finding.id ?? "finding", 700))}${finding.target ? ` (target: ${finding.target})` : ""}`,
        ),
      ),
      ...section("Uncertain in-flight outcomes", unknown, "No in-flight tool, compute, or kernel outcome detected"),
      ...section(
        "Known gaps",
        trace.research.missing.map((item) => `- ${item}`),
      ),
      ...section("Next action", [next]),
      "Do not blindly retry an operation listed under uncertain outcomes. Inspect its durable state first.",
      "",
    ]
    const dir = path.join(Instance.worktree, ".openscience", "checkpoints")
    await ignore(dir)
    const stamp = new Date().toISOString().replace(/[.:]/g, "-")
    const label = input.label ? slug(input.label) : ""
    const name = [stamp, label, crypto.randomUUID().slice(0, 8)].filter(Boolean).join("-") + ".md"
    const file = path.join(dir, name)
    const content = OpenScience.redactSecrets(lines.join("\n"))
    await fs.writeFile(file, content, { flag: "wx", mode: 0o600 })
    const relative = path.relative(Instance.worktree, file)
    return {
      path: file,
      relative,
      summary: `${todos.filter((todo) => todo.status === "completed").length}/${todos.length} plan items complete; ${trace.research.readiness}% research readiness; ${unknown.length} uncertain in-flight outcomes.`,
    }
  }
}
