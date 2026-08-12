import { WindowsJob } from "../../src/process/windows-job"

const [action, name] = process.argv.slice(2)
if (action !== "terminate" || !name) throw new Error("usage: windows-job.ts terminate <job-name>")
process.exit(WindowsJob.terminate(name) ? 0 : 1)
