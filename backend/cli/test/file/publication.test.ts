import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Bus } from "../../src/bus"
import { PublicationFile } from "../../src/file/publication"
import { PublicationReview } from "../../src/file/review"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { CommandRuntime } from "../../src/science/command/registry"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { sandboxedExecution, tmpdir, trustProject } from "../fixture/fixture"

const posixTest = process.platform === "win32" ? test.skip : test

describe("PublicationFile", () => {
  test("detects real local publication export capabilities", async () => {
    const capabilities = await PublicationFile.capabilities()
    expect(capabilities.formats.html).toBe(true)
    expect(capabilities.formats.docx).toBe(capabilities.pandoc)
    expect(capabilities.formats.pptx).toBe(capabilities.pandoc)
    expect(capabilities.formats.pdf).toBe(capabilities.pandoc && Boolean(capabilities.pdf_engine))
  })

  test("exports a secure standalone HTML publication without external tooling", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(
          path.join(directory, "report.md"),
          "# Treatment response\n\nThe observed response was **42%**.\n\n<script>alert('unsafe')</script>\n",
        )
      },
    })
    const result = await PublicationFile.render(tmp.path, { path: "report.md", format: "html" })
    expect(result.path).toMatch(/^exports\/report-\d{8}-\d{9}-[a-f0-9]{8}\.html$/)
    expect(result.size).toBeGreaterThan(100)
    expect(result.engine).toBe("OpenScience Markdown")
    expect(result.readiness).toBe("draft")
    const html = await Bun.file(path.join(tmp.path, result.path)).text()
    expect(html).toContain("Treatment response")
    expect(html).toContain("Content-Security-Policy")
    expect(html).not.toContain("<script>alert")
  })

  test("never overwrites a rapid repeated export", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.md"), "# Stable export\n")
      },
    })

    const [first, second] = await Promise.all([
      PublicationFile.render(tmp.path, { path: "report.md", format: "html" }),
      PublicationFile.render(tmp.path, { path: "report.md", format: "html" }),
    ])
    expect(first.path).not.toBe(second.path)
    expect(await Bun.file(path.join(tmp.path, first.path)).exists()).toBe(true)
    expect(await Bun.file(path.join(tmp.path, second.path)).exists()).toBe(true)
  })

  test("rejects non-report inputs and project traversal", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "data.csv"), "a,b\n1,2\n")
      },
    })
    await expect(PublicationFile.render(tmp.path, { path: "data.csv", format: "html" })).rejects.toThrow("Markdown")
    await expect(PublicationFile.render(tmp.path, { path: "../report.md", format: "html" })).rejects.toThrow("escapes")
  })

  test("rejects a Markdown source symlink that escapes the project", async () => {
    await using outside = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "secret.md"), "# External secret\n")
      },
    })
    await using tmp = await tmpdir({
      init: async (directory) => {
        await fs.symlink(path.join(outside.path, "secret.md"), path.join(directory, "report.md"))
      },
    })

    await expect(PublicationFile.render(tmp.path, { path: "report.md", format: "html" })).rejects.toThrow("escapes")
  })

  test("refuses an exports symlink instead of writing an HTML publication outside the project", async () => {
    await using outside = await tmpdir()
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.md"), "# Confined result\n")
        await fs.symlink(outside.path, path.join(directory, "exports"))
      },
    })

    await expect(PublicationFile.render(tmp.path, { path: "report.md", format: "html" })).rejects.toThrow("ambiguous")
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: outside.path }))).toEqual([])
  })

  test("requires project trust before launching a tool-backed publication export", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.md"), "# Untrusted result\n")
        const bin = path.join(directory, "bin")
        const marker = path.join(directory, "pandoc-ran")
        await fs.mkdir(bin, { recursive: true })
        await Bun.write(path.join(bin, "pandoc"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`)
        await fs.chmod(path.join(bin, "pandoc"), 0o755)
        return { bin, marker }
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const prior = process.env.PATH
        process.env.PATH = `${tmp.extra.bin}${path.delimiter}${prior ?? ""}`
        try {
          await expect(PublicationFile.render(tmp.path, { path: "report.md", format: "docx" })).rejects.toBeInstanceOf(
            ProjectTrust.DeniedError,
          )
          expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)
          expect(CommandRuntime.list(Instance.project.id, "publication")).toEqual([])
        } finally {
          process.env.PATH = prior
        }
      },
    })
  })

  posixTest("reaps background converter descendants before accepting and returning an export", async () => {
    await using _sandbox = await sandboxedExecution()
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.md"), "# Descendant-safe export\n")
        const bin = path.join(directory, "bin")
        await fs.mkdir(bin, { recursive: true })
        await Bun.write(
          path.join(bin, "pandoc"),
          `#!/bin/sh
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    output=$1
  fi
  shift
done
sleep 600 </dev/null >/dev/null 2>&1 &
pid=$!
printf '%s' "$pid" > "$output"
exit 0
`,
        )
        await fs.chmod(path.join(bin, "pandoc"), 0o755)
        return bin
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const prior = process.env.PATH
        process.env.PATH = `${tmp.extra}${path.delimiter}${prior ?? ""}`
        const descendant = { pid: 0 }
        try {
          const result = await PublicationFile.render(tmp.path, { path: "report.md", format: "docx" })
          descendant.pid = Number((await Bun.file(path.join(tmp.path, result.path)).text()).trim())
          expect(descendant.pid).toBeGreaterThan(0)
          expect(() => process.kill(descendant.pid, 0)).toThrow()
          expect(CommandRuntime.list(Instance.project.id, "publication")).toEqual([])
        } finally {
          process.env.PATH = prior
          if (descendant.pid > 0) {
            try {
              process.kill(descendant.pid, "SIGKILL")
            } catch {}
          }
        }
      },
    })
  })

  posixTest("settles and releases a publication child that exits after forced-stop reporting fails", async () => {
    await using _sandbox = await sandboxedExecution()
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.md"), "# Late child cleanup\n")
        const bin = path.join(directory, "bin")
        await fs.mkdir(bin, { recursive: true })
        await Bun.write(path.join(bin, "pandoc"), "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n")
        await fs.chmod(path.join(bin, "pandoc"), 0o755)
        return bin
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const prior = process.env.PATH
        process.env.PATH = `${tmp.extra}${path.delimiter}${prior ?? ""}`
        const state = { job: "", forced: 0 }
        using _ = PublicationFile.testing({
          timeoutMs: 20,
          job: (value) => (state.job = value),
          afterForcedTermination: () => {
            state.forced++
            throw new Error("injected post-termination reporting failure")
          },
        })
        try {
          await expect(PublicationFile.render(tmp.path, { path: "report.md", format: "docx" })).rejects.toThrow()
          for (const _ of Array.from({ length: 400 })) {
            const released = state.job && !(await Bun.file(state.job).exists())
            if (released && CommandRuntime.list(Instance.project.id, "publication").length === 0) break
            await Bun.sleep(10)
          }
          expect(state.job).not.toBe("")
          expect(state.forced).toBeGreaterThan(0)
          expect(await Bun.file(state.job).exists()).toBe(false)
          expect(CommandRuntime.list(Instance.project.id, "publication")).toEqual([])
        } finally {
          process.env.PATH = prior
        }
      },
    })
  })

  test("reaps a registered publication converter before trust revocation is acknowledged", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.md"), "# Revocable export\n")
        const bin = path.join(directory, "bin")
        await fs.mkdir(bin, { recursive: true })
        await Bun.write(
          path.join(bin, "pandoc"),
          `#!/bin/sh
while true; do sleep 1; done
`,
        )
        await fs.chmod(path.join(bin, "pandoc"), 0o755)
        return bin
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const prior = process.env.PATH
        process.env.PATH = `${tmp.extra}${path.delimiter}${prior ?? ""}`
        const unsubscribe = Bus.subscribe(ProjectTrust.Event.Changed, async (event) => {
          if (!event.properties.status.canExecuteProjectCode) {
            await CommandRuntime.stopProject(Instance.project.id)
          }
        })
        try {
          const pending = PublicationFile.render(tmp.path, { path: "report.md", format: "docx" })
          const outcome = pending.then(
            () => undefined,
            (error) => error as Error,
          )
          await (async () => {
            for (const _ of Array.from({ length: 200 })) {
              if (CommandRuntime.list(Instance.project.id, "publication").length) return
              await Bun.sleep(10)
            }
            throw new Error("Timed out waiting for the revocable Pandoc process")
          })()

          const revoked = await ProjectTrust.update(Instance.project, { trusted: false })
          expect(revoked.state).toBe("revoked")
          expect((await outcome)?.message).toContain("Pandoc exited")
          expect(CommandRuntime.list(Instance.project.id, "publication")).toEqual([])
          expect(await Bun.file(path.join(tmp.path, "exports")).exists()).toBe(false)
        } finally {
          unsubscribe()
          process.env.PATH = prior
        }
      },
    })
  })

  test("owns a connected-folder converter with the real session and reaps it on grant revocation", async () => {
    await using _sandbox = await sandboxedExecution()
    await using connected = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.md"), "# Connected revocable export\n")
        const bin = path.join(directory, "bin")
        await fs.mkdir(bin, { recursive: true })
        await Bun.write(path.join(bin, "pandoc"), "#!/bin/sh\nwhile true; do sleep 1; done\n")
        await fs.chmod(path.join(bin, "pandoc"), 0o755)
        return bin
      },
    })
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }
        const grant = await SessionFilesystem.grant({
          sessionID: session.id,
          path: connected.path,
          access: "write",
          scope: "session",
        })
        const unsubscribe = Bus.subscribe(SessionFilesystem.Event.Changed, async (event) => {
          if (event.properties.grant.time.revoked) {
            await CommandRuntime.stopSession(Instance.project.id, event.properties.sessionID)
          }
        })
        const prior = process.env.PATH
        process.env.PATH = `${connected.extra}${path.delimiter}${prior ?? ""}`
        try {
          const pending = File.publication(
            { path: path.join(connected.path, "report.md"), format: "docx" },
            { sessionID: session.id },
          )
          const outcome = pending.then(
            () => undefined,
            (error) => error as Error,
          )
          await (async () => {
            for (const _ of Array.from({ length: 200 })) {
              if (CommandRuntime.list(Instance.project.id, session.id).length) return
              await Bun.sleep(10)
            }
            throw new Error("Timed out waiting for the session-owned Pandoc process")
          })()
          expect(CommandRuntime.list(Instance.project.id, "publication")).toEqual([])
          await SessionFilesystem.revoke(session.id, grant.id)
          expect((await outcome)?.message).toContain("Pandoc exited")
          expect(CommandRuntime.list(Instance.project.id, session.id)).toEqual([])
          expect(await Bun.file(path.join(connected.path, "exports")).exists()).toBe(false)
        } finally {
          unsubscribe()
          process.env.PATH = prior
        }
      },
    })
  })

  test("gates reviewed exports on a finalized report for the exact source bytes", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "README.md"), "# Publication fixture\n")
        await Bun.write(path.join(directory, "uv.lock"), "version = 1\n")
        await Bun.write(path.join(directory, "pyproject.toml"), '[project]\nname = "publication-fixture"\n')
        await Bun.write(path.join(directory, "report.md"), "# Stable result\n\nAll structural checks pass.\n")
        await $`git add README.md uv.lock pyproject.toml report.md`.cwd(directory).quiet()
        await $`git -c user.name=OpenScience -c user.email=test@openscience.local commit -m "publication fixture"`
          .cwd(directory)
          .quiet()
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const review = await PublicationReview.run({ path: "report.md", actor: "Reviewer" })
        await expect(
          PublicationFile.render(tmp.path, {
            path: "report.md",
            format: "html",
            readiness: "reviewed",
            review_id: review.id,
          }),
        ).rejects.toThrow("finalized")

        const finalized = await PublicationReview.finalize(review.id, { actor: "Aayam Bansal" })
        const result = await PublicationFile.render(tmp.path, {
          path: "report.md",
          format: "html",
          readiness: "reviewed",
          review_id: finalized.id,
        })
        expect(result).toMatchObject({
          readiness: "reviewed",
          review_id: finalized.id,
        })

        await Bun.write(path.join(tmp.path, "report.md"), "# Changed after review\n")
        await expect(
          PublicationFile.render(tmp.path, {
            path: "report.md",
            format: "html",
            readiness: "reviewed",
            review_id: finalized.id,
          }),
        ).rejects.toThrow("changed")
        expect(
          (
            await PublicationFile.render(tmp.path, {
              path: "report.md",
              format: "html",
              readiness: "draft",
            })
          ).readiness,
        ).toBe("draft")
      },
    })
  })

  test("a reviewed Pandoc export renders the finalized snapshot when the source changes mid-export", async () => {
    await using _sandbox = await sandboxedExecution()
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "README.md"), "# Publication snapshot fixture\n")
        await Bun.write(path.join(directory, "uv.lock"), "version = 1\n")
        await Bun.write(path.join(directory, "pyproject.toml"), '[project]\nname = "publication-snapshot-fixture"\n')
        await Bun.write(path.join(directory, "report.md"), "# Reviewed result\n\nThe finalized value is 42%.\n")
        await $`git add README.md uv.lock pyproject.toml report.md`.cwd(directory).quiet()
        await $`git -c user.name=OpenScience -c user.email=test@openscience.local commit -m "snapshot fixture"`
          .cwd(directory)
          .quiet()
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const review = await PublicationReview.run({ path: "report.md", actor: "Reviewer" })
        const finalized = await PublicationReview.finalize(review.id, { actor: "Aayam Bansal" })
        const original = await Bun.file(path.join(tmp.path, "report.md")).text()
        const bin = path.join(tmp.path, "bin")
        const resume = path.join(tmp.path, "pandoc-resume")
        const projectWrite = path.join(tmp.path, "converter-project-write")
        const pandoc = path.join(bin, "pandoc")
        await fs.mkdir(bin, { recursive: true })
        await Bun.write(
          pandoc,
          `#!/bin/sh
source="$1"
shift
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    output="$1"
  fi
  shift
done
if [ -n "$LAB_ACCESS_TOKEN" ]; then exit 91; fi
if printf escaped > ${JSON.stringify(projectWrite)}; then exit 92; fi
while [ ! -f ${JSON.stringify(resume)} ]; do sleep 0.01; done
cp "$source" "$output"
`,
        )
        await fs.chmod(pandoc, 0o755)
        const prior = process.env.PATH
        const priorSecret = process.env.LAB_ACCESS_TOKEN
        process.env.PATH = `${bin}${path.delimiter}${prior ?? ""}`
        process.env.LAB_ACCESS_TOKEN = "must-not-enter-publication-export"
        const pending = PublicationFile.render(tmp.path, {
          path: "report.md",
          format: "docx",
          readiness: "reviewed",
          review_id: finalized.id,
        })
        try {
          const command = await (async () => {
            for (const _ of Array.from({ length: 200 })) {
              const live = CommandRuntime.list(Instance.project.id, "publication")[0]
              if (live) return live
              await Bun.sleep(10)
            }
            throw new Error("Timed out waiting for Pandoc to enter the command ledger")
          })()
          expect(command).toMatchObject({
            sessionID: "publication",
            messageID: "publication",
            state: "running",
            process_id: expect.any(Number),
          })
          await Bun.write(path.join(tmp.path, "report.md"), "# Changed after validation\n")
          await Bun.write(resume, "resume")
          const result = await pending
          expect(await Bun.file(path.join(tmp.path, result.path)).text()).toBe(original)
          expect(await Bun.file(projectWrite).exists()).toBe(false)
          expect(CommandRuntime.list(Instance.project.id, "publication")).toEqual([])
        } finally {
          process.env.PATH = prior
          if (priorSecret === undefined) delete process.env.LAB_ACCESS_TOKEN
          else process.env.LAB_ACCESS_TOKEN = priorSecret
          await Bun.write(resume, "resume")
        }
      },
    })
  })
})
