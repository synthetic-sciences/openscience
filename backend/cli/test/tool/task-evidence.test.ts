import { expect, test } from "bun:test"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { ArtifactTool } from "../../src/tool/artifact"
import { TaskEvidence } from "../../src/tool/task-evidence"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

test("Task hands back only this turn's immutable child outputs, readable by the parent without scratch access", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const ctx = {
        sessionID: child.id,
        messageID: "msg_old",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {},
      }
      const source = path.join(await SessionFilesystem.workspace(child.id), "report.md")
      const content = "α".repeat(25_599) + "🧬" + "important final evidence".repeat(500)
      await Bun.write(source, "old report")
      const tool = await ArtifactTool.init()
      await tool.execute({ action: "save_file", path: source }, ctx)
      await Bun.write(source, content)
      await tool.execute({ action: "save_file", path: source }, { ...ctx, messageID: "msg_new" })
      await Bun.write(source, "later mutable scratch must not change handoff")
      const msg = (id: string): MessageV2.WithParts => ({
        info: {
          id,
          sessionID: child.id,
          role: "user",
          agent: "research",
          effort: "normal",
          model: { providerID: "fixture", modelID: "offline" },
          time: { created: 1 },
        },
        parts: [],
      })
      const changed = ["application.py", "backend.py", "campaign.py", "matrix.py"].map((file) =>
        path.join(tmp.path, file),
      )
      const deleted = path.join(tmp.path, "obsolete.py")
      const movedFrom = path.join(tmp.path, "draft.py")
      const movedTo = path.join(tmp.path, "final.py")
      const mutationMessage: MessageV2.WithParts = {
        info: {
          id: "msg_mutations",
          sessionID: child.id,
          role: "assistant",
          parentID: "msg_new",
          mode: "execute",
          agent: "execute",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "offline",
          providerID: "fixture",
          time: { created: 2, completed: 3 },
          finish: "tool-calls",
        },
        parts: [
          {
            id: "prt_patch_one",
            sessionID: child.id,
            messageID: "msg_mutations",
            type: "tool",
            tool: "apply_patch",
            callID: "call_patch_one",
            state: {
              status: "completed",
              input: {},
              title: "Updated application and backend",
              output: "Success",
              metadata: {
                files: [
                  { filePath: changed[0], relativePath: "application.py" },
                  { filePath: changed[1], relativePath: "backend.py" },
                ],
              },
              time: { start: 2, end: 2 },
            },
          },
          {
            id: "prt_patch_two",
            sessionID: child.id,
            messageID: "msg_mutations",
            type: "tool",
            tool: "apply_patch",
            callID: "call_patch_two",
            state: {
              status: "completed",
              input: {},
              title: "Updated campaign and matrix",
              output: "Success",
              metadata: {
                files: [
                  { filePath: changed[2], relativePath: "campaign.py" },
                  { filePath: changed[3], relativePath: "matrix.py" },
                  { filePath: deleted, relativePath: "obsolete.py", type: "delete" },
                  { filePath: movedFrom, relativePath: "draft.py", movePath: movedTo, type: "move" },
                ],
              },
              time: { start: 2, end: 3 },
            },
          },
        ],
      }
      const evidence = await TaskEvidence.collect({
        projectID: Instance.project.id,
        sessionID: child.id,
        messages: [msg("msg_old"), msg("msg_new"), mutationMessage],
        previous: new Set(["msg_old"]),
      })
      expect(evidence.artifacts).toHaveLength(1)
      const artifact = evidence.artifacts[0]
      expect(evidence.mutations).toHaveLength(2)
      expect(evidence.mutations.flatMap((receipt) => receipt.files)).toEqual([...changed, movedTo])
      expect(evidence.mutations.flatMap((receipt) => receipt.removed)).toEqual([deleted, movedFrom])
      const description = TaskEvidence.describe(evidence)
      expect(description).toContain(artifact.versionID)
      expect(description).toContain("5 unique files across 2 successful mutation calls")
      expect(description).toContain(JSON.stringify(changed[3]))
      expect(description).toContain(JSON.stringify(movedTo))
      expect(description).not.toContain(JSON.stringify(deleted))
      expect(description).not.toContain(JSON.stringify(movedFrom))
      await expect(
        SessionFilesystem.authorize({ sessionID: parent.id, path: source, access: "read" }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      const params = { action: "read_file" as const, artifact_id: artifact.artifactID, version_id: artifact.versionID }
      const read = await tool.execute(params, { ...ctx, sessionID: parent.id })
      expect(read.metadata.sha256).toBe(artifact.sha256)
      expect(read.metadata.nextOffset).toBe(51_198)
      const rest = await tool.execute(
        { ...params, offset: read.metadata.nextOffset as number },
        { ...ctx, sessionID: parent.id },
      )
      expect(read.output.split("\n\n[More content:")[0] + rest.output).toBe(content)
      await expect(tool.execute({ ...params, version_id: "foreign-version" }, ctx)).rejects.toThrow("unavailable")
      await expect(tool.execute({ action: "read_file", artifact_id: artifact.artifactID }, ctx)).rejects.toThrow(
        "invalid arguments",
      )
      expect(await ArtifactStore.read("another-project", artifact.artifactID, artifact.versionID)).toBeUndefined()
      await Session.remove(child.id)
      await Session.remove(parent.id)
    },
  })
})

test("shell writes are read from the command text: redirects, tee and heredocs, not devices or stdin", () => {
  expect(
    TaskEvidence.shellWrites("cat > /tmp/Interp.lean <<'EOF'\nimport Mathlib\nEOF\nlake env lean /tmp/Interp.lean"),
  ).toEqual(["/tmp/Interp.lean"])
  expect(
    TaskEvidence.shellWrites("python train.py 2>&1 | tee logs/run.log && echo done >> results/summary.txt"),
  ).toEqual(["results/summary.txt", "logs/run.log"])
  expect(TaskEvidence.shellWrites("grep -c sorry src/*.lean; ls > /dev/null; echo $x 2>/dev/null")).toEqual([])
  expect(TaskEvidence.shellWrites("python3 - <<'PY'\nprint(1)\nPY")).toEqual([])
})

async function commands(
  inputs: {
    command: string
    output?: string
    exit?: number | null
    truncated?: boolean
    error?: string
  }[],
) {
  await using tmp = await tmpdir({ git: true })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const message: MessageV2.WithParts = {
        info: {
          id: "msg_commands",
          sessionID: session.id,
          role: "assistant",
          parentID: "msg_parent",
          mode: "execute",
          agent: "execute",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "offline",
          providerID: "fixture",
          time: { created: 1, completed: 2 },
        },
        parts: inputs.map((input, index): MessageV2.ToolPart => ({
          id: `prt_${index}`,
          sessionID: session.id,
          messageID: "msg_commands",
          type: "tool",
          tool: "bash",
          callID: `call_${index}`,
          state: input.error
            ? {
                status: "error",
                input: { command: input.command, description: `Check ${index}` },
                error: input.error,
                metadata: { output: input.output ?? "", truncated: input.truncated },
                time: { start: 1, end: 2 },
              }
            : {
                status: "completed",
                input: { command: input.command, description: `Check ${index}` },
                title: `Check ${index}`,
                output: input.output ?? "",
                metadata: {
                  ...(input.exit !== undefined && { exit: input.exit }),
                  ...(input.truncated !== undefined && { truncated: input.truncated }),
                  provenanceID: `run_${index}`,
                },
                time: { start: 1, end: 2 },
              },
        })),
      }
      const evidence = await TaskEvidence.collect({
        projectID: Instance.project.id,
        sessionID: session.id,
        messages: [message],
        previous: new Set(),
      })
      await Session.remove(session.id)
      return evidence
    },
  })
}

const passing = " 61 pass\n 0 fail\n 120 expect() calls\nRan 61 tests across 4 files. [198.00ms]\n"
const failing = " 4 pass\n 1 fail\n 9 expect() calls\nRan 5 tests across 1 file. [100.00ms]\n"

test("a successful non-test command returns its actual output as evidence", async () => {
  const evidence = await commands([{ command: "printf 'MARKER_41\\n'", output: "MARKER_41\n", exit: 0 }])
  const description = TaskEvidence.describe(evidence)
  expect(description).toContain('output excerpt="MARKER_41\\n"')
  expect(description).toContain("call_0")
  expect(description).toContain("outer exit=0")
  expect(evidence.commands[0].checks).toBeUndefined()
})

test("an aborted command retains its saved streaming output without claiming success", async () => {
  const evidence = await commands([
    { command: "printf PARTIAL_42; sleep 90", output: "PARTIAL_42", error: "Tool execution aborted" },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description).toContain('output excerpt="PARTIAL_42"')
  expect(description).toContain("status=error")
  expect(description).toContain("outer exit=unknown")
  expect(description).toContain("output incomplete")
})

test("large command output stays bounded with head, tail and an explicit incomplete label", async () => {
  const evidence = await commands([
    { command: "cat huge.txt", output: "FIRST_43\n" + "noise".repeat(50000) + "\nLAST_43", exit: 0 },
    { command: "cat truncated.txt", output: "CUT_44", exit: 0, truncated: true },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description).toContain("FIRST_43")
  expect(description).toContain("LAST_43")
  expect(description).toContain("CUT_44")
  expect(description.match(/output incomplete/g)).toHaveLength(2)
  expect(description.length).toBeLessThan(4000)
  expect(JSON.stringify(evidence.commands).length).toBeLessThan(4000)
})

test("compacted Task receipts retain bounded command evidence without a worker report", async () => {
  const evidence = await commands([{ command: "printf SAVED_45", output: "SAVED_45", exit: 0 }])
  const summary = MessageV2.toolSummary("task", {
    status: "completed",
    title: "Interrupted fixture",
    input: {},
    output: "",
    metadata: {
      outcome: "partial",
      stopReason: "deadline",
      commandReceipts: TaskEvidence.describe(evidence),
    },
    time: { start: 1, end: 2 },
  })
  expect(summary).toContain('output excerpt="SAVED_45"')
  expect(summary).toContain("call_0")
  expect(summary).toContain("deadline")
  expect(summary).toContain("Task completion: unverified.")
})

test("the latest output remains visible after many commands while failed tests stay first", async () => {
  const evidence = await commands([
    { command: "bun test ./red.test.ts", output: failing, exit: 0 },
    ...Array.from({ length: 12 }, (_, index) => ({
      command: `printf EARLIER_${index}`,
      output: `EARLIER_${index}`,
      exit: 0,
    })),
    { command: "printf LATEST_47", output: "LATEST_47", exit: 0 },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description).toContain('output excerpt="LATEST_47"')
  expect(description.indexOf("4 pass, 1 fail")).toBeLessThan(description.indexOf('output excerpt="LATEST_47"'))
  expect(description).toContain("additional command receipts omitted")
})

test("escaped command output stays within the compacted receipt budget", async () => {
  const evidence = await commands(
    Array.from({ length: 12 }, (_, index) => ({
      command: `cat result_${index}`,
      output: "\u0001".repeat(2000),
      exit: 0,
    })),
  )
  const receipt = TaskEvidence.describeCommands(evidence.commands)
  expect(receipt.length).toBeLessThanOrEqual(12000)
  expect(receipt).toContain("Command receipts truncated")
  const summary = MessageV2.toolSummary("task", {
    status: "completed",
    title: "Long output",
    input: {},
    output: "",
    metadata: { outcome: "partial", stopReason: "deadline", commandReceipts: receipt },
    time: { start: 1, end: 2 },
  })
  expect(summary).toContain("Command receipts truncated")
})

test("fallback reports saved Bun test summaries with exact outer exits and trace references", async () => {
  const evidence = await commands([
    { command: "cd backend/cli && bun test --timeout 15000 ./test/tool", output: passing, exit: 0 },
    { command: "bun run --cwd backend/cli test; echo done", output: failing, exit: 0 },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description).toContain("tool output reported")
  expect(description).toContain("61 pass, 0 fail")
  expect(description).toContain("4 pass, 1 fail")
  expect(description).toContain("outer exit=0")
  expect(description).toContain("not independently verified")
  expect(description).toContain("msg_commands")
  expect(description).toContain("prt_0")
  expect(description).toContain("call_1")
  expect(description).toContain("run_0")
  expect(description).toContain("bun test --timeout 15000 ./test/tool")
})

test("fallback does not multiply duplicate Bun summaries or infer tests from printed fixtures", async () => {
  const evidence = await commands([
    { command: "bun test ./test/tool 2>&1 | tee results.txt", output: passing + passing, exit: 0 },
    { command: "cat test-fixture.txt", output: failing, exit: 0 },
    { command: "echo 'bun test'", output: failing, exit: 0 },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description.match(/61 pass, 0 fail/g)).toHaveLength(1)
  expect(description).not.toContain("122 pass")
  expect(description).not.toContain("4 pass, 1 fail")
  expect(description).toContain('"results.txt"')
})

test("fallback leaves missing, incomplete and truncated test outputs explicitly uncertain", async () => {
  const evidence = await commands([
    { command: "bun test ./missing.test.ts", exit: 0 },
    { command: "bun test ./partial.test.ts", output: "61 pass\n0 fail\n", exit: 0 },
    { command: "bun test ./truncated.test.ts", output: passing, exit: 0, truncated: true },
    { command: "bun test ./interrupted.test.ts", error: "Deadline interrupted command" },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description.match(/test outcome unknown/g)).toHaveLength(3)
  expect(description).toContain("output truncated; other results may be missing")
  expect(description).toContain("61 pass, 0 fail")
  expect(description).toContain("outer exit=unknown")
  expect(description).toContain("Deadline interrupted command")
})

test("fallback distinguishes failed shell commands from test results and bounds receipt display", async () => {
  const evidence = await commands([
    { command: "rg missing src", output: "", exit: 1 },
    { command: "find . | head -1", output: "find: write error: Broken pipe", exit: 141 },
    { command: "cat missing.txt", output: "cat: missing.txt: No such file or directory", exit: 1 },
    ...Array.from({ length: 12 }, (_, index) => ({ command: `rg missing${index} src`, exit: 1 })),
    { command: `bun test ${"very-long-path/".repeat(1000)}`, output: failing, exit: 0 },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description).toContain("rg missing src")
  expect(description).toContain("outer exit=141")
  expect(description).toContain("Broken pipe")
  expect(description).toContain("No such file or directory")
  expect(description).toContain("4 pass, 1 fail")
  expect(description).toContain("omitted")
  expect(description).not.toContain("test failures")
  expect(description.length).toBeLessThan(6500)
})

test("legacy evidence without command details remains readable", () => {
  const description = TaskEvidence.describe({
    artifacts: [],
    mutations: [],
    commands: [
      {
        messageID: "msg_legacy",
        partID: "prt_legacy",
        callID: "call_legacy",
        status: "completed",
        exit: 0,
        written: [],
      },
    ],
  })
  expect(description).toContain("1 shell calls, 1 with outer exit 0")
  expect(description).not.toContain("tool output reported")
})

test("fallback recognizes deadline-wrapped test pipelines without trusting quoted shell examples", async () => {
  const evidence = await commands([
    {
      command:
        "cd /project/backend/cli && git status --short | wc -l; timeout 900 bun test --timeout 15000 test/session/subagent-budget.test.ts 2>&1 | tail -60; git status --short | wc -l",
      output: passing.replace("4 files", "7 files"),
      exit: 0,
    },
    {
      command:
        'cd /project/backend/cli && timeout 900 bun test --timeout 15000 test/tool/task-handoff.test.ts 2>&1 | grep -E "^\\(fail\\)|pass$|fail$|Ran |error:" | tail -30; cd ../..; git status --porcelain | diff /tmp/sa_before.txt - && echo CLEAN',
      output: "45 pass\n0 fail\nRan 45 tests across 5 files. [41.49s]\nCLEAN\n",
      exit: 0,
    },
    { command: "printf 'example; timeout 900 bun test ./fake.test.ts'", output: failing, exit: 0 },
    { command: "cat <<'EOF'\nbun test ./fake.test.ts\nEOF", output: failing, exit: 0 },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description).toContain("61 pass, 0 fail")
  expect(description).toContain("45 pass, 0 fail")
  expect(description).not.toContain("4 pass, 1 fail")
})

test("bounded output parsing retains tail summaries without joining disjoint output into a result", async () => {
  const tail = "0 fail\nRan 61 tests across 4 files.\n"
  const split = "x\n".repeat(16_380) + "61 pass\n" + "z".repeat(20_000) + tail + "x".repeat(32_768 - tail.length)
  const evidence = await commands([
    { command: "bun test ./split.test.ts", output: split, exit: 0 },
    { command: "bun test ./tail.test.ts", output: "noise\n".repeat(20_000) + failing, exit: 0 },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description).not.toContain("61 pass, 0 fail")
  expect(description).toContain("4 pass, 1 fail")
  expect(description).toContain("test outcome unknown")
  expect(description.match(/output truncated; other results may be missing/g)).toHaveLength(2)
})

test("an incomplete passing summary cannot consume a later complete failing summary", async () => {
  const evidence = await commands([
    {
      command: "bun test ./first.test.ts; bun test ./second.test.ts; true",
      output: "61 pass\n0 fail\n" + failing,
      exit: 0,
    },
  ])
  const description = TaskEvidence.describe(evidence)
  expect(description).toContain("4 pass, 1 fail")
  expect(description).not.toContain("61 pass, 0 fail")
})
