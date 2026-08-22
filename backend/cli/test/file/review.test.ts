import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { PublicationReview } from "../../src/file/review"
import { Instance } from "../../src/project/instance"
import { Provenance } from "../../src/science/provenance/store"
import { tmpdir } from "../fixture/fixture"

describe("PublicationReview", () => {
  test("records concrete citation, numeric, figure, and provenance findings", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "references.bib"), "@article{known2024, title={Known result}}\n")
        await Bun.write(path.join(directory, "figures", "observed.png"), "not-a-real-image")
        await Bun.write(
          path.join(directory, "report.md"),
          [
            "---",
            "bibliography: references.bib",
            "---",
            "# Treatment response",
            "",
            "The response improved by 42% (p = 0.01).",
            "",
            "Prior work supports the mechanism [@missing2024].",
            "",
            "The secondary endpoint remained stable[^missing].",
            "",
            "![Observed response](figures/observed.png)",
            "",
            "![Missing panel](figures/missing.png)",
            "",
            "[citation needed]",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const report = await PublicationReview.run({
          path: "report.md",
          actor: "Aayam Bansal",
        })
        expect(report.format).toBe("openscience.publication-review.v1")
        expect(report.artifactHash).toMatch(/^[a-f0-9]{64}$/)
        expect(report.status).toBe("blocked")
        const checks = new Set(report.findings.map((finding) => finding.check))
        expect(checks.has("citation")).toBe(true)
        expect(checks.has("numeric")).toBe(true)
        expect(checks.has("figure")).toBe(true)
        expect(checks.has("provenance")).toBe(true)
        expect(report.findings.find((finding) => finding.title.includes("missing2024"))).toMatchObject({
          severity: "blocking",
          status: "open",
          location: { path: "report.md", line: 8 },
        })
        expect(report.findings.find((finding) => finding.title.includes("missing.png"))).toMatchObject({
          severity: "blocking",
          status: "open",
        })
        expect(report.findings.find((finding) => finding.title.includes("observed.png"))).toMatchObject({
          severity: "major",
          status: "open",
        })
        expect(report.events).toEqual([
          expect.objectContaining({ type: "generated", actor: "Aayam Bansal", version: 1 }),
        ])
        expect(report.summary.blocking).toBeGreaterThanOrEqual(2)
      },
    })
  })

  test("resolves block bibliographies and reference-style or balanced figure destinations", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "refs", "paper.bib"), "@article{known2026, title={Known result}}\n")
        await Bun.write(path.join(directory, "figures", "result_(final).png"), "figure")
        await Bun.write(
          path.join(directory, "report.md"),
          [
            "---",
            "bibliography:",
            "  - refs/paper.bib",
            "---",
            "# Result",
            "",
            "Prior work supports this result [@known2026].",
            "",
            "![Observed][result]",
            '![Missing](<figures/missing panel.png> "Panel")',
            "",
            '[result]: figures/result_(final).png "Final result"',
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const report = await PublicationReview.run({ path: "report.md", actor: "Reviewer" })
        expect(report.findings.some((finding) => finding.title.includes("known2026"))).toBe(false)
        expect(report.findings.some((finding) => finding.title.includes("result_(final).png is missing"))).toBe(false)
        expect(report.findings.find((finding) => finding.title.includes("missing panel.png is missing"))).toMatchObject(
          {
            location: { path: "report.md", line: 10 },
          },
        )
      },
    })
  })

  test("does not treat email addresses, comments, or code examples as scientific claims", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "references.bib"), "@article{known2026, title={Known result}}\n")
        await Bun.write(
          path.join(directory, "report.md"),
          [
            "---",
            "bibliography: references.bib",
            "contact: author@example.com",
            "---",
            "# Result",
            "",
            "Prior work is documented [@known2026]. Contact author@example.com.",
            "",
            "`TODO: cite a 99% result from @inlinefake`",
            "",
            "```text",
            "[citation needed] 88% @fencedfake",
            "```",
            "",
            "<!-- TODO: cite 77% @commentfake -->",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const report = await PublicationReview.run({ path: "report.md", actor: "Reviewer" })
        expect(report.findings.filter((finding) => finding.check === "citation")).toEqual([])
        expect(report.findings.filter((finding) => finding.check === "numeric")).toEqual([])
      },
    })
  })

  test("finalizes the exact reviewed bytes after attributed resolutions and overrides", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "README.md"), "# Review fixture\n")
        await Bun.write(path.join(directory, "uv.lock"), "version = 1\n")
        await Bun.write(path.join(directory, "pyproject.toml"), '[project]\nname = "review-fixture"\n')
        await Bun.write(
          path.join(directory, "report.md"),
          "# Result\n\nThe response was 42% [citation needed] and differs from prior work [@missing2024].\n",
        )
        await $`git add README.md uv.lock pyproject.toml report.md`.cwd(directory).quiet()
        await $`git -c user.name=OpenScience -c user.email=test@openscience.local commit -m "review fixture"`
          .cwd(directory)
          .quiet()
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const report = await PublicationReview.run({ path: "report.md", actor: "Reviewer" })
        await expect(PublicationReview.finalize(report.id, { actor: "Reviewer" })).rejects.toThrow("blocking findings")
        const blockers = report.findings.filter((finding) => finding.severity === "blocking")
        for (const [index, finding] of blockers.entries()) {
          await PublicationReview.resolve(report.id, finding.id, {
            status: index ? "overridden" : "resolved",
            actor: "Aayam Bansal",
            reason: index ? "Accepted for this exploratory release." : "Verified against the source record.",
          })
        }
        const finalized = await PublicationReview.finalize(report.id, { actor: "Aayam Bansal" })
        expect(finalized.finalized).toMatchObject({
          actor: "Aayam Bansal",
          artifactHash: report.artifactHash,
        })
        const events = finalized.events.map((event) => event.type)
        expect(events).toContain("resolved")
        expect(events).toContain("overridden")
        expect(events).toContain("finalized")
        expect(await PublicationReview.assertReady("report.md", report.id)).toMatchObject({
          id: report.id,
          artifactHash: report.artifactHash,
        })

        await Bun.write(path.join(tmp.path, "report.md"), "# Result\n\nThe response changed.\n")
        await expect(PublicationReview.assertReady("report.md", report.id)).rejects.toThrow("changed")
      },
    })
  })

  test("recognizes a traced manuscript and keeps report history across source versions", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "README.md"), "# Ready fixture\n")
        await Bun.write(path.join(directory, "uv.lock"), "version = 1\n")
        await Bun.write(path.join(directory, "pyproject.toml"), '[project]\nname = "ready-fixture"\n')
        await Bun.write(
          path.join(directory, "manuscript", "references.bib"),
          "@article{known2024, title={Known result}}\n",
        )
        await Bun.write(path.join(directory, "manuscript", "figures", "response.svg"), "<svg></svg>")
        await Bun.write(
          path.join(directory, "manuscript", "report.md"),
          [
            "---",
            "bibliography: references.bib",
            "---",
            "# Result",
            "",
            "The response was 42% (Figure 1; @known2024).",
            "",
            "![Response](figures/response.svg)",
            "",
          ].join("\n"),
        )
        await $`git add .`.cwd(directory).quiet()
        await $`git -c user.name=OpenScience -c user.email=test@openscience.local commit -m "ready fixture"`
          .cwd(directory)
          .quiet()
      },
    })

    await Provenance.record({
      kind: "artifact",
      label: "Response figure",
      artifactType: "figure",
      path: "manuscript/figures/response.svg",
      meta: { directory: tmp.path },
    } as Parameters<typeof Provenance.record>[0])
    await Instance.provide({
      directory: path.join(tmp.path, "manuscript"),
      fn: async () => {
        const first = await PublicationReview.run({ path: "report.md", actor: "Reviewer" })
        expect(first.findings.filter((finding) => finding.severity === "blocking")).toEqual([])
        expect(first.status).not.toBe("blocked")
        expect(first.path).toBe("manuscript/report.md")

        await Bun.write(
          path.join(tmp.path, "manuscript", "report.md"),
          `${await Bun.file(path.join(tmp.path, "manuscript", "report.md")).text()}\n`,
        )
        const second = await PublicationReview.run({ path: "report.md", actor: "Reviewer" })
        expect(second.id).not.toBe(first.id)
        expect(second.artifactHash).not.toBe(first.artifactHash)
        expect((await PublicationReview.history("report.md")).map((report) => report.id)).toEqual([first.id, second.id])
      },
    })
  })
})
