import { tool, type Connector, type Plugin } from "@synsci/plugin"

// Test-only deterministic records. Integration tests copy this module outside
// the project to exercise the public plugin loader and its trust boundary.

const samples = [
  { id: "calibration-a", title: "Calibration sample A", values: [1, 2, 3] },
  { id: "calibration-b", title: "Calibration sample B", values: [2, 4, 6] },
]

const source: Connector = {
  id: "local-lab",
  name: "Test calibration records",
  domain: "general",
  description: "Deterministic calibration records for plugin contract tests.",
  async search(query, options) {
    options?.signal?.throwIfAborted()
    return samples
      .filter((sample) => `${sample.id} ${sample.title}`.toLowerCase().includes(query.toLowerCase()))
      .slice(0, options?.limit ?? 10)
      .map((sample) => ({ id: sample.id, title: sample.title, extra: { values: sample.values } }))
  },
  async fetch(id, options) {
    options?.signal?.throwIfAborted()
    const sample = samples.find((sample) => sample.id === id)
    if (!sample) throw new Error(`Unknown local sample: ${id}`)
    return sample
  },
}

const CalibrationPlugin = (async () => ({
  connector: [source],
  tool: {
    local_lab_summary: tool({
      description: "Compute the count and arithmetic mean of a numeric sample and return a CSV attachment.",
      args: { values: tool.schema.array(tool.schema.number().finite()).min(1).max(10000) },
      async execute(args, context) {
        context.abort.throwIfAborted()
        const mean = args.values.reduce((sum, value) => sum + value / args.values.length, 0)
        const csv = `count,mean\n${args.values.length},${mean}\n`
        return {
          title: "Sample summary",
          output: `${args.values.length} observations; mean ${mean}. The CSV is attached.`,
          metadata: {
            count: args.values.length,
            mean,
            method: "arithmetic mean",
            ...(context.callID ? { callID: context.callID } : {}),
          },
          attachments: [
            {
              type: "file",
              mime: "text/csv",
              filename: "summary.csv",
              url: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`,
            },
          ],
        }
      },
    }),
  },
})) satisfies Plugin

export default CalibrationPlugin
