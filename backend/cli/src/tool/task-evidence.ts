import { ArtifactStore } from "@/artifact/store"
import type { MessageV2 } from "@/session/message-v2"
import { observableToolStatus } from "@/session/tool-outcome"

/** Evidence is derived from persisted execution records, never parsed out of
 * the worker's prose. Exit zero is an outer-process result, not test success. */
export namespace TaskEvidence {
  function mutation(part: MessageV2.ToolPart) {
    if (part.state.status !== "completed") return
    const metadata = part.state.metadata
    const change = (() => {
      if (part.tool === "apply_patch") {
        if (!Array.isArray(metadata.files)) return { files: [], removed: [] }
        const files: string[] = []
        const removed: string[] = []
        for (const item of metadata.files) {
          if (!item || typeof item !== "object") continue
          const file = item as {
            relativePath?: unknown
            filePath?: unknown
            movePath?: unknown
            type?: unknown
          }
          const source = typeof file.filePath === "string" ? file.filePath : file.relativePath
          if (file.type === "delete") {
            if (typeof source === "string" && source) removed.push(source)
            continue
          }
          if (typeof file.movePath === "string" && file.movePath) {
            if (typeof source === "string" && source) removed.push(source)
            files.push(file.movePath)
            continue
          }
          if (typeof source === "string" && source) files.push(source)
        }
        return { files, removed }
      }
      if (part.tool === "edit") {
        const file = metadata.filediff
        if (!file || typeof file !== "object" || !("file" in file) || typeof file.file !== "string")
          return { files: [], removed: [] }
        return { files: [file.file], removed: [] }
      }
      if (part.tool === "write" && typeof metadata.filepath === "string")
        return { files: [metadata.filepath], removed: [] }
      return { files: [], removed: [] }
    })()
    const files = [...new Set(change.files)]
    const removed = [...new Set(change.removed)]
    if (!files.length && !removed.length) return
    return {
      messageID: part.messageID,
      partID: part.id,
      callID: part.callID,
      tool: part.tool,
      files,
      removed,
    }
  }

  /** Paths a shell command writes to, read from its text: `> file`, `>> file`,
   * `tee file`, `cat > file <<EOF`. Best effort; temporary and device paths
   * are skipped. */
  export function shellWrites(command: string): string[] {
    const out = new Set<string>()
    for (const match of command.matchAll(/(?:^|[^<>|&])>{1,2}\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|)]+))/g)) {
      const target = match[1] ?? match[2] ?? match[3]
      if (target && !target.startsWith("&") && !target.startsWith("/dev/")) out.add(target)
    }
    for (const match of command.matchAll(/\btee\s+(?:-a\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|)]+))/g)) {
      const target = match[1] ?? match[2] ?? match[3]
      if (target && !target.startsWith("-") && !target.startsWith("/dev/")) out.add(target)
    }
    return [...out].filter((value) => value !== "/dev/null" && !/^\$\(/.test(value))
  }

  export async function collect(input: {
    projectID: string
    sessionID: string
    messages: MessageV2.WithParts[]
    previous: Set<string>
  }) {
    const current = input.messages.filter((message) => !input.previous.has(message.info.id))
    const ids = new Set(current.map((message) => message.info.id))
    const artifacts = (await ArtifactStore.listSessionVersions(input.projectID, input.sessionID))
      .filter((version) => version.messageID && ids.has(version.messageID))
      .map((version) => ({
        artifactID: version.artifactID,
        versionID: version.id,
        filename: version.filename,
        size: version.size,
        sha256: version.sha256,
        captureQuality: version.captureQuality,
      }))
    const commands = current
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.tool !== "bash") return []
          const metadata = part.state.status === "completed" ? part.state.metadata : undefined
          const command = typeof part.state.input?.command === "string" ? part.state.input.command : ""
          return [
            {
              messageID: part.messageID,
              partID: part.id,
              callID: part.callID,
              status: observableToolStatus(part),
              exit: typeof metadata?.exit === "number" ? metadata.exit : null,
              ...(typeof metadata?.provenanceID === "string" && { provenanceID: metadata.provenanceID }),
              // Files the shell wrote (redirects, tee, heredocs): the file
              // tools leave receipts, a heredoc leaves nothing, and a lead
              // that cannot see where a worker's work landed cannot use it.
              written: metadata?.exit === 0 ? shellWrites(command) : [],
            },
          ]
        }),
      )
    const mutations = current
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool") return []
          const receipt = mutation(part)
          return receipt ? [receipt] : []
        }),
      )
    return { artifacts, commands, mutations }
  }

  export function describe(evidence: Awaited<ReturnType<typeof collect>>) {
    const lines = evidence.artifacts.map(
      (artifact) =>
        `- ${JSON.stringify(artifact.filename)}: artifact_id=${artifact.artifactID}, version_id=${artifact.versionID}, bytes=${artifact.size}, sha256=${artifact.sha256}`,
    )
    const files: string[] = []
    const seen = new Set<string>()
    for (const receipt of evidence.mutations) {
      for (const file of receipt.removed) {
        seen.delete(file)
        const index = files.indexOf(file)
        if (index >= 0) files.splice(index, 1)
      }
      for (const file of receipt.files) {
        if (seen.has(file)) continue
        seen.add(file)
        files.push(file)
      }
    }
    const shell = [...new Set(evidence.commands.flatMap((item) => item.written ?? []))].filter(
      (file) => !seen.has(file),
    )
    return [
      ...(lines.length
        ? ["Saved outputs (immutable versions; use artifact read_file with these exact IDs):", ...lines]
        : []),
      ...(evidence.commands.length
        ? [
            `Execution receipts: ${evidence.commands.length} shell calls, ${evidence.commands.filter((item) => item.exit === 0).length} with outer exit 0, ${evidence.commands.filter((item) => item.status === "error").length} failed. Full receipts remain in the child trace. An outer exit 0 alone does not verify nested tests or scientific conclusions.`,
          ]
        : []),
      ...(files.length
        ? [
            `Completed file changes: ${files.length} unique ${files.length === 1 ? "file" : "files"} across ${evidence.mutations.length} successful mutation ${evidence.mutations.length === 1 ? "call" : "calls"}.`,
            ...files.map((file) => `- ${JSON.stringify(file)}`),
            "Full mutation receipts remain in the child trace.",
          ]
        : []),
      ...(shell.length
        ? [
            `Files written by shell commands (from the command text; verify before relying on them): ${shell.length}.`,
            ...shell.slice(0, 40).map((file) => `- ${JSON.stringify(file)}`),
          ]
        : []),
    ].join("\n")
  }
}
