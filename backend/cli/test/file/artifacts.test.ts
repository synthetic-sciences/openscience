import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { ArtifactFile } from "../../src/file/artifacts"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { tmpdir } from "../fixture/fixture"

describe("ArtifactFile.classify", () => {
  test.each([
    ["analysis.ipynb", "notebook"],
    ["cells.h5ad", "dataset"],
    ["counts.parquet", "dataset"],
    ["figure.svg", "figure"],
    ["manuscript.pdf", "report"],
    ["protein.cif", "structure"],
    ["reads.fastq", "sequence"],
    ["cohort.vcf", "genomics"],
    ["run.mzML", "spectrum"],
    ["weights.safetensors", "model"],
    ["bundle.zip", "archive"],
  ])("classifies %s as %s", (file, kind) => {
    expect(ArtifactFile.classify(file)?.kind).toBe(ArtifactFile.Kind.parse(kind))
  })

  test("does not treat source code as a research artifact", () => {
    expect(ArtifactFile.classify("pipeline.py")).toBeUndefined()
  })
})

describe("File.artifacts", () => {
  test("discovers local artifacts recursively with metadata and skips dependency trees", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "analysis.ipynb"), "{}")
        await Bun.write(path.join(directory, "results", "figure.png"), Uint8Array.from([1, 2, 3]))
        await Bun.write(path.join(directory, "results", "table.csv"), "x,y\n1,2\n")
        await Bun.write(path.join(directory, "src", "pipeline.py"), "print('not an artifact')")
        await Bun.write(path.join(directory, "node_modules", "package", "paper.pdf"), "skip")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.artifacts()
        expect(result.map((item) => item.path).toSorted()).toEqual([
          "analysis.ipynb",
          "results/figure.png",
          "results/table.csv",
        ])
        expect(result.find((item) => item.path === "analysis.ipynb")).toMatchObject({
          kind: "notebook",
          format: "ipynb",
          size: 2,
        })
        expect(result.find((item) => item.path === "results/figure.png")).toMatchObject({
          kind: "figure",
          format: "png",
          size: 3,
        })
      },
    })
  })

  test("discovers every persistent session-authorized root and keeps connected paths absolute", async () => {
    await using external = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "paper.md"), "# Connected paper\n")
        await Bun.write(path.join(directory, "figures", "result.png"), Uint8Array.from([1, 2, 3]))
      },
    })
    await using tmp = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "local.csv"), "metric,value\naccuracy,0.9\n"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }
        await SessionFilesystem.grant({
          sessionID: session.id,
          path: external.path,
          access: "read",
          scope: "session",
        })

        const result = await File.artifacts({ sessionID: session.id })
        expect(result.map((item) => item.path)).toContain("local.csv")
        expect(result.map((item) => item.path)).toContain(path.join(external.path, "paper.md"))
        expect(result.map((item) => item.path)).toContain(path.join(external.path, "figures", "result.png"))
      },
    })
  })

  test("surfaces an artifact scan failure instead of returning a misleading empty result", async () => {
    await using tmp = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "result.csv"), "value\n1\n"),
    })
    await expect(ArtifactFile.scan(path.join(tmp.path, "result.csv"))).rejects.toMatchObject({ code: "ENOTDIR" })
  })

  test("keeps reachable artifacts when a nested broad-root subtree is unreadable", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "visible.csv"), "value\n1\n")
        await fs.mkdir(path.join(directory, "locked"), { recursive: true })
        await Bun.write(path.join(directory, "locked", "hidden.csv"), "value\n2\n")
      },
    })
    const locked = path.join(tmp.path, "locked")
    await fs.chmod(locked, 0)
    try {
      expect((await ArtifactFile.scan(tmp.path)).map((item) => item.path)).toContain("visible.csv")
    } finally {
      await fs.chmod(locked, 0o755)
    }
  })
})

describe("File.provenance", () => {
  test.skipIf(process.platform === "win32")(
    "does not execute repository-controlled fsmonitor configuration",
    async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (directory) => {
          await Bun.write(path.join(directory, "results.csv"), "metric,value\naccuracy,0.9\n")
          await $`git add results.csv`.cwd(directory).quiet()
          await $`git -c user.name=OpenScience -c user.email=test@openscience.local commit -m baseline`
            .cwd(directory)
            .quiet()
          const marker = path.join(directory, "fsmonitor-executed")
          const hook = path.join(directory, "fsmonitor.sh")
          await Bun.write(hook, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nexit 1\n`)
          await fs.chmod(hook, 0o755)
          await $`git config core.fsmonitor ${hook}`.cwd(directory).quiet()
          return marker
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await File.provenance("results.csv")
          await ArtifactFile.audit(tmp.path)
          expect(await Bun.file(tmp.extra).exists()).toBeFalse()
        },
      })
    },
  )

  test("reports branch, latest commit, and dirty state for a tracked artifact", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "results.csv"), "metric,value\naccuracy,0.9\n")
        await $`git add results.csv`.cwd(directory).quiet()
        await $`git -c user.name=OpenScience -c user.email=test@openscience.local commit -m "record baseline"`
          .cwd(directory)
          .quiet()
        await Bun.write(path.join(directory, "results.csv"), "metric,value\naccuracy,0.95\n")
      },
    })
    const branch = (await $`git branch --show-current`.cwd(tmp.path).quiet().text()).trim()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.provenance("results.csv")
        expect(result).toMatchObject({
          path: "results.csv",
          tracked: true,
          dirty: true,
          status: "modified",
          branch,
          commit: {
            author: "OpenScience",
            email: "test@openscience.local",
            message: "record baseline",
          },
        })
        expect(result.commit?.sha).toHaveLength(40)
      },
    })
  })

  test("reports a clean local-only state outside git", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.pdf"), "pdf")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await File.provenance("report.pdf")).toMatchObject({
          tracked: false,
          dirty: false,
          status: "local",
        })
      },
    })
  })

  test("uses the connected folder's Git repository without traversing above the grant", async () => {
    await using connected = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "paper.md"), "# Connected\n")
        await $`git add paper.md`.cwd(directory).quiet()
        await $`git -c user.name=Connected -c user.email=connected@openscience.local commit -m "connected paper"`
          .cwd(directory)
          .quiet()
      },
    })
    await using tmp = await tmpdir({ git: true })
    const branch = (await $`git branch --show-current`.cwd(connected.path).quiet().text()).trim()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }
        await SessionFilesystem.grant({
          sessionID: session.id,
          path: connected.path,
          access: "read",
          scope: "session",
        })

        expect(await File.provenance(path.join(connected.path, "paper.md"), { sessionID: session.id })).toMatchObject({
          path: path.join(connected.path, "paper.md"),
          tracked: true,
          dirty: false,
          status: "clean",
          branch,
          commit: {
            author: "Connected",
            email: "connected@openscience.local",
            message: "connected paper",
          },
        })
      },
    })
  })

  test("does not inspect parent Git metadata for an exact-file grant", async () => {
    await using connected = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "paper.md"), "# Connected\n")
        await $`git add paper.md`.cwd(directory).quiet()
        await $`git -c user.name=Connected -c user.email=connected@openscience.local commit -m "connected paper"`
          .cwd(directory)
          .quiet()
      },
    })
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }
        const file = path.join(connected.path, "paper.md")
        await SessionFilesystem.grant({ sessionID: session.id, path: file, access: "read", scope: "session" })
        expect(await File.provenance(file, { sessionID: session.id })).toEqual({
          path: file,
          tracked: false,
          dirty: false,
          status: "local",
        })
      },
    })
  })
})
