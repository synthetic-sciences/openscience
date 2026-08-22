import { describe, expect, test } from "bun:test"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SessionResearch } from "../../src/session/research"
import { AtlasTool } from "../../src/tool/atlas"
import { BashTool } from "../../src/tool/bash"
import { TaskTool } from "../../src/tool/task"
import { Tool } from "../../src/tool/tool"
import {
  RAW_TOOL_ERRORS,
  STRESS_CATEGORIES,
  STRESS_MATRIX,
  validateStressMatrix,
} from "../../../../evals/cadence-harness/stress-matrix"
import { tmpdir } from "../fixture/fixture"

describe("deterministic harness stress matrix", () => {
  test("declares dozens of unique sessions across every required failure surface", () => {
    const report = validateStressMatrix()

    expect(report.count).toBe(57)
    expect(report.unique).toBe(true)
    expect(report.missing).toEqual([])
    expect(report.invalid).toEqual([])
    expect(Object.keys(report.categories).toSorted()).toEqual([...STRESS_CATEGORIES].toSorted())
    expect(Math.min(...Object.values(report.categories))).toBeGreaterThanOrEqual(3)
  })

  test("gives every scenario a deterministic observable oracle", () => {
    for (const scenario of STRESS_MATRIX) {
      expect(scenario.expect.terminal).toMatch(/^(completed|failed|blocked|pending)$/)
      expect(scenario.expect.excludes).toEqual(expect.arrayContaining(RAW_TOOL_ERRORS))
      expect(scenario.stimulus.kind).toMatch(/^(reply|tool|error|disconnect|inspect)$/)
      if (scenario.stimulus.kind === "tool") expect(scenario.expect.tools).toBeDefined()
      if (scenario.stimulus.kind === "error") expect(scenario.stimulus.status).toBeGreaterThanOrEqual(400)
    }
  })

  test("uses the real model-facing contracts for Atlas, delegation, and Bash aliases", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const atlas = await AtlasTool.init()
        const bash = await BashTool.init()
        const task = await TaskTool.init()
        for (const scenario of STRESS_MATRIX) {
          if (scenario.stimulus.kind !== "tool") continue
          if (scenario.stimulus.name === "atlas") {
            expect(Tool.validate("atlas", atlas, scenario.stimulus.input)).toMatchObject({ success: true })
          }
          if (scenario.stimulus.name === "task") {
            expect(Tool.validate("task", task, scenario.stimulus.input)).toMatchObject({ success: true })
          }
          if (scenario.id === "malformed_tools.alias-bash") {
            expect(Tool.validate("bash", bash, scenario.stimulus.input)).toMatchObject({ success: true })
          }
        }

        const malformed = STRESS_MATRIX.find((scenario) => scenario.id === "malformed_tools.empty-bash")
        if (malformed?.stimulus.kind !== "tool") throw new Error("Malformed Bash fixture is missing")
        expect(Tool.validate("bash", bash, malformed.stimulus.input)).toMatchObject({ success: false })
      },
    })
  })

  test("creates and isolates one real session shell for every matrix entry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessions = await Promise.all(STRESS_MATRIX.map((scenario) => Session.create({ title: scenario.id })))
        try {
          const workspaces = await Promise.all(sessions.map((session) => SessionFilesystem.workspace(session.id)))
          const grants = await Promise.all(sessions.map((session) => SessionFilesystem.list(session.id)))
          const contracts = await Promise.all(sessions.map((session) => SessionResearch.read(session.id)))

          expect(new Set(sessions.map((session) => session.id)).size).toBe(STRESS_MATRIX.length)
          expect(new Set(workspaces).size).toBe(STRESS_MATRIX.length)
          expect(contracts).toEqual(Array.from({ length: STRESS_MATRIX.length }, () => undefined))
          expect(await ArtifactStore.list(Instance.project.id)).toEqual([])
          for (const [index, workspace] of workspaces.entries()) {
            expect(grants[index]).toContainEqual(
              expect.objectContaining({ path: workspace, access: "write", source: "workspace" }),
            )
            expect(grants[index]?.some((grant) => grant.path === workspaces[(index + 1) % workspaces.length])).toBe(
              false,
            )
          }
        } finally {
          await Promise.all(sessions.map((session) => Session.remove(session.id)))
        }
      },
    })
  })
})
