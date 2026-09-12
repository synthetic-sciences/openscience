import { afterEach, describe, expect, test } from "bun:test"
import { Experiments } from "../../src/experiments"

const projectID = `prj_test_${Math.random().toString(36).slice(2, 10)}`

afterEach(() => Experiments.close())

describe("experiment runs", () => {
  test("ingests points idempotently and derives the headline from the last metric value", async () => {
    const run = await Experiments.createRun({ projectID, name: "baseline", source: "external", config: { lr: 0.01 } })
    expect(run.status).toBe("running")
    const first = await Experiments.ingest(
      run.id,
      [
        { key: "val_loss", step: 1, value: 1.0 },
        { key: "val_loss", step: 2, value: 0.8 },
        { key: "train_loss", step: 2, value: 0.9 },
      ],
      { projectID },
    )
    expect(first?.accepted).toBe(3)
    // A replayed batch changes nothing.
    const replay = await Experiments.ingest(run.id, [{ key: "val_loss", step: 2, value: 0.8 }], { projectID })
    expect(replay?.run.points).toBe(3)
    expect(replay?.run.lastStep).toBe(2)
    await Experiments.summarize(run.id, { val_loss: 0.75, note: "x" }, { projectID })
    const finished = await Experiments.finishRun(run.id, "finished", { projectID })
    // No study: the headline follows the first summary key.
    expect(finished?.headline).toBe(0.75)
    expect(finished?.status).toBe("finished")
    const keys = await Experiments.metricKeys({ projectID, runIDs: [run.id] })
    expect(keys).toEqual(["train_loss", "val_loss"])
  })

  test("downsamples long series into equal step buckets", async () => {
    const run = await Experiments.createRun({ projectID, name: "long", source: "external" })
    const points = Array.from({ length: 2000 }, (_, step) => ({ key: "loss", step, value: 2000 - step }))
    await Experiments.ingest(run.id, points, { projectID })
    const [series] = await Experiments.series({ projectID, runIDs: [run.id], keys: ["loss"], max: 100 })
    expect(series?.points.length).toBe(100)
    expect(series?.points[0]?.value).toBeGreaterThan(series?.points.at(-1)?.value ?? Infinity)
    expect(series?.points.at(-1)?.step).toBe(1999)
  })
})

describe("studies", () => {
  test("ranks ideas, tracks baseline deltas by direction, and records results with lessons", async () => {
    const study = await Experiments.createStudy({
      projectID,
      sessionID: "ses_test",
      name: "tiny sgd",
      purpose: "fit y = 3x + 2",
      metric: "val_mse",
      direction: "minimize",
      root: "/tmp/study",
      concurrency: 2,
      budget: { maxRuns: 10 },
    })
    expect(study.status).toBe("running")
    const ideas = await Experiments.proposeIdeas(
      study.id,
      [
        { title: "baseline", description: "plain sgd", why: "reference", ev: 0, config: { lr: 0.01 } },
        { title: "momentum", description: "add momentum", why: "smoother", ev: 0.4, config: { momentum: 0.9 } },
        { title: "more steps", description: "double steps", why: "underfit", ev: 0.2, config: { steps: 80 } },
      ],
      { projectID },
    )
    expect(ideas).toHaveLength(3)
    // Baseline is pinned to the front by priority even at EV 0.
    await Experiments.updateIdea(ideas[0]!.id, { priority: 1000 }, { projectID })
    const next = await Experiments.nextIdea(study.id, { projectID })
    expect(next?.title).toBe("baseline")

    const baseline = await Experiments.createRun({
      projectID,
      name: "baseline",
      source: "job",
      studyID: study.id,
      ideaID: next!.id,
      jobID: "job_1",
    })
    expect((await Experiments.getIdea(next!.id, { projectID }))?.status).toBe("running")
    await Experiments.ingest(baseline.id, [{ key: "val_mse", step: 40, value: 0.5 }], { projectID })
    await Experiments.finishRun(baseline.id, "finished", { projectID })
    await Experiments.setBaseline(study.id, baseline.id, { projectID })
    await Experiments.recordResult({ projectID, studyID: study.id, runID: baseline.id, kept: true, analysis: "ok" })

    const second = await Experiments.nextIdea(study.id, { projectID })
    expect(second?.title).toBe("momentum")
    const improved = await Experiments.createRun({
      projectID,
      name: "momentum",
      source: "job",
      studyID: study.id,
      ideaID: second!.id,
      jobID: "job_2",
    })
    await Experiments.ingest(improved.id, [{ key: "val_mse", step: 40, value: 0.3 }], { projectID })
    const done = await Experiments.finishRun(improved.id, "finished", { projectID })
    // Lower is better: a drop of 0.2 is a positive delta.
    expect(done?.baselineDelta).toBeCloseTo(0.2)
    const after = await Experiments.recordResult({
      projectID,
      studyID: study.id,
      runID: improved.id,
      kept: true,
      analysis: "momentum helps",
      lessons: "momentum 0.9 is a safe default here",
    })
    expect(after?.bestRunID).toBe(improved.id)
    expect(after?.lessons).toContain("momentum 0.9")
    expect((await Experiments.getIdea(second!.id, { projectID }))?.status).toBe("kept")
    expect(await Experiments.runForJob("job_2", { projectID })).toMatchObject({ id: improved.id })
    expect((await Experiments.studyForSession("ses_test", { projectID }))?.id).toBe(study.id)

    const overview = await Experiments.overview(study.id, { projectID })
    expect(overview?.runs).toHaveLength(2)
    expect(overview?.events.map((event) => event.kind)).toContain("kept")
    expect(overview?.best?.id).toBe(improved.id)
  })
})
