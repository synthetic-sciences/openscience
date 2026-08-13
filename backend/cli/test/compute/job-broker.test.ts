import { expect, test } from "bun:test"
import { JobBroker } from "../../src/compute/job-broker"
import { ComputeJobs } from "../../src/compute/jobs"

test("JobBroker is the single compatible facade for every compute target", () => {
  expect(JobBroker).toBe(ComputeJobs)
  expect(JobBroker.Target.options.map((target) => target.shape.kind.value)).toEqual(["local", "ssh", "modal"])
  expect(JobBroker.Scheduler.options).toEqual(["none", "slurm", "pbs"])
  expect(
    JobBroker.Request.safeParse({
      name: "analysis",
      purpose: "Compare candidate estimators and save the score table.",
      command: "python compare.py",
      target: { kind: "local" },
      sessionID: "ses_123",
    }).success,
  ).toBe(true)
})
