import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { Acceptance, AcceptanceUnit } from "../../../src/harness/acceptance"
import { HarnessState } from "../../../src/harness/state"
import { Bus } from "../../../src/bus"
import { PermissionNext } from "../../../src/permission/next"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { tmpdir, trustProject } from "../../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../../fixture/stress-provider"
import type { PluginInput } from "@synsci/plugin"

afterEach(() => HarnessState.reset())

test("detect reads build and test commands a request requires, with their directory", () => {
  const proof = Acceptance.detect(
    [
      "Prove the theorem in the Lean project at `/task/`. Your proof must:",
      "1. Compile with `lake build GSLean` (run from `/task/`)",
      "2. Pass the axiom audit: `#print axioms main_theorem` may use only `propext`.",
      "3. Avoid banned syntax anywhere under `/task/GSLean/`: `sorry`, `admit`, `axiom`, `native_decide`.",
    ].join("\n"),
  )
  expect(proof.commands).toEqual([{ command: "lake build GSLean", cwd: "/task" }])
  expect(proof.banned).toEqual([{ tokens: ["sorry", "admit", "axiom", "native_decide"], scope: "/task/GSLean" }])

  const tests = Acceptance.detect(
    "Implement the solver in `solver.py`. The hidden tests are like `tests/test_public.py`; your code must pass `pytest -q tests/` and the shipped checker `python check_submission.py` must succeed.",
  )
  expect(tests.commands.map((entry) => entry.command)).toEqual(["pytest -q tests/", "python check_submission.py"])
  expect(tests.banned).toEqual([])

  // Usage examples and file names are not checks; a forbidding sentence
  // without a scope is not a grep.
  const none = Acceptance.detect(
    "You can inspect the data with `python explore.py` if useful. Save results to `results/out.csv`. Do not use `numpy.random` without a seed.",
  )
  expect(none).toEqual({ commands: [], banned: [] })

  // A compiler is a check when it names its source; flags alone would fail
  // for the wrong reason.
  expect(
    Acceptance.detect("The verifier compiles `/app/solution.cpp` with `g++ -O3 -std=c++17 -I/app`.").commands,
  ).toEqual([])
  expect(Acceptance.detect("Your submission must compile with `g++ -O2 -o solver solver.cpp`.").commands).toEqual([
    { command: "g++ -O2 -o solver solver.cpp" },
  ])
})

test("run and grep report the grader's view: exit code with the output's tail, banned tokens as file:line", async () => {
  await using tmp = await tmpdir({ git: true })
  await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
  await fs.writeFile(path.join(tmp.path, "src", "Main.lean"), "theorem t : True := by\n  sorry\n")
  await fs.writeFile(
    path.join(tmp.path, "check.sh"),
    "#!/bin/sh\necho checking\ntest -f results/out.txt || { echo 'results/out.txt missing' >&2; exit 3; }\n",
  )
  const failed = await Acceptance.run({ command: "sh check.sh" }, tmp.path, 10_000)
  expect(failed?.detail).toContain("exited with code 3")
  expect(failed?.detail).toContain("results/out.txt missing")
  const banned = await Acceptance.grep({ tokens: ["sorry", "admit"], scope: "src" }, tmp.path)
  expect(banned?.detail).toContain("src/Main.lean:2: `sorry`")
  // A grader greps every file under the scope; a hidden leftover with the old
  // content is found the same way.
  await fs.writeFile(path.join(tmp.path, "src", ".editor-leftover.tmp"), "theorem t : True := by\n  sorry\n")
  const hidden = await Acceptance.grep({ tokens: ["sorry"], scope: "src" }, tmp.path)
  expect(hidden?.detail).toContain("src/.editor-leftover.tmp:2: `sorry`")
  await fs.rm(path.join(tmp.path, "src", ".editor-leftover.tmp"))
  await fs.mkdir(path.join(tmp.path, "results"), { recursive: true })
  await fs.writeFile(path.join(tmp.path, "results", "out.txt"), "ok")
  await fs.writeFile(path.join(tmp.path, "src", "Main.lean"), "theorem t : True := trivial\n")
  expect(await Acceptance.run({ command: "sh check.sh" }, tmp.path, 10_000)).toBeUndefined()
  expect(await Acceptance.grep({ tokens: ["sorry", "admit"], scope: "src" }, tmp.path)).toBeUndefined()
  // A hanging check is reported as such, not waited on for the session.
  const hung = await Acceptance.run({ command: "sh -c 'sleep 30'" }, tmp.path, 500)
  expect(hung?.detail).toContain("did not finish")
})

/** A model that says "done" until the acceptance report appears, then writes the file. */
function server(root: { value: string }) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  let writes = 0
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-acceptance",
      object: "chat.completion.chunk",
      created: 1,
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}),
    })}\n\n`
  const reply = (content: string) =>
    new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  const instance = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      requests.push(body)
      const conversation = JSON.stringify(body.messages)
      if (!conversation.includes("Methods and deliverables")) return reply("title")
      const hasToolResult = conversation.includes('"role":"tool"') || conversation.includes("tool-result")
      if (conversation.includes("acceptance checks the request states") && !hasToolResult && writes === 0) {
        writes++
        const call = {
          id: "call_write",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({ filePath: `${root.value}/results/out.txt`, content: "ok\n" }),
          },
        }
        return new Response(
          chunk({ role: "assistant", tool_calls: [{ index: 0, ...call }] }, null) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return reply(writes ? "Wrote results/out.txt; the check passes now." : "All done.")
    },
  })
  return { instance, requests }
}

test("a stated check that fails continues the turn with the grader's output, and stands once it passes", async () => {
  const root = { value: "" }
  const fixture = server(root)
  // The check runs through the session's bash tool, so a trusted project in
  // approve mode puts the same card in front of the person that the model's
  // own `sh check.sh` would; this client approves each once.
  const asked: PermissionNext.Request[] = []
  try {
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${fixture.instance.url.origin}/v1`) })
    root.value = tmp.path
    await fs.writeFile(
      path.join(tmp.path, "check.sh"),
      "#!/bin/sh\ntest -f results/out.txt || { echo 'results/out.txt missing' >&2; exit 3; }\n",
    )
    await Instance.provide({
      directory: tmp.path,
      init: trustProject,
      fn: async () => {
        Bus.subscribe(PermissionNext.Event.Asked, async (event) => {
          asked.push(event.properties)
          await PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
        })
        const session = await Session.create({ workspace: "project" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          parts: [
            {
              type: "text",
              text: "Produce the summary the checker expects. Your work must pass `sh check.sh` (run from the project root).",
            },
          ],
        })
        const state = HarnessState.get(session.id)
        expect(state.acceptance.commands).toEqual([{ command: "sh check.sh" }])
        const messages = await Session.messages({ sessionID: session.id })
        const parts = messages.flatMap((message) => message.parts)
        const report = parts.find(
          (part) =>
            part.type === "text" && part.synthetic && part.text.includes("acceptance checks the request states"),
        )
        expect(report).toBeDefined()
        expect(report?.type === "text" && report.text).toContain("results/out.txt missing")
        expect(await Bun.file(path.join(tmp.path, "results", "out.txt")).text()).toBe("ok\n")
        expect(parts.some((part) => part.type === "text" && part.text.includes("the check passes now"))).toBe(true)
        expect(state.acceptanceFailing).toBe(false)
        expect(state.acceptanceRounds).toBe(1)
        // The <env> names the contract, once, in the cached system prompt.
        const main = fixture.requests
          .map((request) => JSON.stringify(request.messages))
          .filter((text) => text.includes("Methods and deliverables"))
        expect(main[0]).toContain("Acceptance (checked before the run ends): `sh check.sh`")
        // Two runs of the check (the failing one, the passing one), each
        // asked for as the bash permission it is, with the command named.
        const shell = asked.filter((request) => request.permission === "bash")
        expect(shell.length).toBeGreaterThanOrEqual(2)
        expect(shell.every((request) => request.patterns.includes("sh check.sh"))).toBe(true)
      },
    })
  } finally {
    fixture.instance.stop(true)
  }
})

test("switching the unit off removes the check", async () => {
  const unit = await AcceptanceUnit({} as PluginInput)
  expect(HarnessState.enabled({ harness: { acceptance: false } } as never, "acceptance")).toBe(false)
  expect(HarnessState.enabled({} as never, "acceptance")).toBe(true)
  expect(typeof unit["loop.before_finish"]).toBe("function")
})

test("bans listed in bullets under a colon line take the scope the paragraph names; prose bullets and allowlists are not bans", () => {
  const text = [
    "3. Use only ordinary definitions in the files under `/task/Proj/Sub/`. The following are **not allowed** anywhere under that subtree:",
    "   - **Proof escapes:** `sorry`, `admit`, `axiom`, `native_decide`.",
    "   - **Syntax:** `macro`, `syntax`, `notation`, `infix`.",
    "   - **Redefining the statement vocabulary** (e.g. defining your own `Tendsto`) or the frozen `Core.lean` API.",
    "",
    "The objective is `fun`. Implement the search in `solver.py`; do not delegate it. In particular, the submitted file must not",
    "invoke `scipy.optimize` or packages such as `cma` or `pymoo`, directly or through wrappers around `fun`.",
    "",
    "`/app/solution.py` runs in an environment providing only `numpy` and `scipy`, so it must not import any other package.",
  ].join("\n")
  const banned = Acceptance.detect(text).banned
  expect(banned).toEqual([
    {
      tokens: ["sorry", "admit", "axiom", "native_decide", "macro", "syntax", "notation", "infix"],
      scope: "/task/Proj/Sub",
    },
    { tokens: ["scipy.optimize", "cma", "pymoo"], scope: "solver.py" },
  ])
})

test("a banned dotted module is found in its from-import form too", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "solver.py"), "import numpy as np\nfrom scipy import linalg, optimize\n")
  await fs.writeFile(
    path.join(tmp.path, "clean.py"),
    "import numpy as np\nfrom scipy import linalg\n# no optimize here\n",
  )
  const hit = await Acceptance.grep({ tokens: ["scipy.optimize"], scope: "solver.py" }, tmp.path)
  expect(hit?.detail).toContain("solver.py:2")
  expect(await Acceptance.grep({ tokens: ["scipy.optimize"], scope: "clean.py" }, tmp.path)).toBeUndefined()
})

test("a labelled ban list of product names, an unbackticked scope, and a wrapped lead-in before a blank line", () => {
  // "Banned: SciPy, Numba, …" names products, not import tokens; the scope
  // is spelled without backticks; the parenthesis explains calls the model
  // reads about rather than names a grep can check.
  const labelled = Acceptance.detect(
    [
      "Allowed: NumPy and the Python standard library, one process. Banned: SciPy, Numba, Cython, PyTorch,",
      "JAX, C/FFI extensions, and numpy.linalg dense solvers (solve, inv, svd). These restrictions apply to",
      "every Python source file under /app/solver, including helper modules.",
    ].join("\n"),
  )
  expect(labelled.banned).toEqual([{ tokens: ["scipy", "numba", "cython", "torch", "jax"], scope: "/app/solver" }])

  // A colon lead-in wrapped across lines, a blank line, then bullets that
  // wrap too; no path in the paragraph, so the list applies to the one file
  // the request has the model write. The requirement's command sits alone
  // on the line after its colon.
  const proof = Acceptance.detect(
    [
      "Complete the proof of `Game.main` in:",
      "",
      "`/app/GameProof/GameProof/Basic.lean`",
      "",
      "You may add helper lemmas inside `Basic.lean`, but you must not modify the theorem statement or any other file.",
      "",
      "Use only ordinary Lean tactics. The following proof escapes that could redefine the verifier's language are not",
      "allowed:",
      "",
      "- `sorry`, `sorryAx`, `admit`, new axioms, `native_decide`, `unsafe`,",
      "  `@[implemented_by]`, `run_cmd`, or `#eval`;",
      "- custom syntax or elaboration through `macro`, `macro_rules`, `elab`,",
      "  `elab_rules`, `syntax`, notation declarations, or custom parser attributes;",
      "- importing or directly referencing the `Lean` metaprogramming namespace.",
      "",
      "The completed project must compile with:",
      "",
      "`lake build --wfail`",
    ].join("\n"),
  )
  expect(proof.commands).toEqual([{ command: "lake build --wfail" }])
  expect(proof.banned).toEqual([
    {
      tokens: [
        "sorry",
        "sorryAx",
        "admit",
        "native_decide",
        "unsafe",
        "@[implemented_by]",
        "run_cmd",
        "#eval",
        "macro",
        "macro_rules",
        "elab",
        "elab_rules",
        "syntax",
      ],
      scope: "/app/GameProof/GameProof/Basic.lean",
    },
  ])
})

test("a build command stated without a directory runs in the one project beneath the root", async () => {
  await using tmp = await tmpdir()
  await fs.mkdir(path.join(tmp.path, "Proj"), { recursive: true })
  await fs.writeFile(path.join(tmp.path, "Proj", "lakefile.toml"), 'name = "Proj"\n')
  // A stand-in for lake: succeeds only where the lakefile is.
  await fs.mkdir(path.join(tmp.path, "bin"))
  await fs.writeFile(
    path.join(tmp.path, "bin", "lake"),
    "#!/bin/sh\ntest -f lakefile.toml || { echo 'no lakefile in' $(pwd) >&2; exit 2; }\necho built\n",
  )
  await fs.chmod(path.join(tmp.path, "bin", "lake"), 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${path.join(tmp.path, "bin")}:${previous}`
  try {
    expect(await Acceptance.run({ command: "lake build --wfail" }, tmp.path, 10_000)).toBeUndefined()
    // A stated directory still wins.
    const stated = await Acceptance.run({ command: "lake build --wfail", cwd: "." }, tmp.path, 10_000)
    expect(stated?.detail).toContain("no lakefile")
  } finally {
    process.env.PATH = previous
  }
})
