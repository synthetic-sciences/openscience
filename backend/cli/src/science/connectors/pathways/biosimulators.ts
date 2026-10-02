import z from "zod"
import type { Connector } from "../types"
import { getJSON, SourceResponseError } from "../http"
import { clampLimit, snippet, stripTags } from "./util"

const API = "https://api.biosimulators.org"
const Term = z.object({ id: z.string(), namespace: z.string().optional() }).passthrough()
const Simulator = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    version: z.string().min(1),
    description: z.string().optional(),
    algorithms: z.array(
      z
        .object({
          id: z.string().nullish(),
          name: z.string().nullish(),
          kisaoId: Term,
          modelFormats: z.array(Term),
        })
        .passthrough(),
    ),
  })
  .passthrough()

// EDAM names published by the registry's /ontologies/EDAM endpoints. Registry
// records carry the ontology IDs rather than these familiar format names.
const formats: Record<string, string> = {
  format_2585: "SBML",
  format_3240: "CellML",
  format_3971: "NeuroML",
  format_3972: "BNGL",
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "")

export const biosimulators: Connector = {
  id: "biosimulators",
  name: "BioSimulators",
  domain: "biology",
  description:
    "Find simulation tools by name, KiSAO algorithm, or model format (SBML, CellML, NeuroML, BNGL). Registry lookup only.",
  homepage: "https://biosimulators.org",

  async search(query, opts) {
    const terms = query.trim().split(/\s+/).map(normalize).filter(Boolean)
    if (!terms.length) return []
    const response = await getJSON(`${API}/simulators/latest?includeTests=false`, { signal: opts?.signal })
    const parsed = Simulator.array().safeParse(response)
    if (!parsed.success) throw new SourceResponseError("BioSimulators returned an invalid simulator catalog")
    return parsed.data
      .filter((record) => {
        const general = [record.id, record.name].map(normalize)
        // A combined format/algorithm query must describe one supported
        // algorithm, rather than two unrelated capabilities of a simulator.
        return (
          record.algorithms.some((algorithm) => {
            const values = [
              ...general,
              ...[algorithm.id ?? "", algorithm.name ?? "", algorithm.kisaoId.id].map(normalize),
              ...algorithm.modelFormats.flatMap((format) => [
                normalize(format.id),
                normalize(formats[format.id] ?? ""),
              ]),
            ]
            return terms.every((term) => values.some((value) => value.includes(term)))
          }) || terms.every((term) => general.some((value) => value.includes(term)))
        )
      })
      .sort(
        (a, b) =>
          Number(normalize(b.id) === normalize(query)) - Number(normalize(a.id) === normalize(query)) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, clampLimit(opts?.limit, 10, 50))
      .map((record) => ({
        id: `${record.id}/${record.version}`,
        title: `${record.name} ${record.version}`,
        summary: snippet(stripTags(record.description)),
        url: `https://biosimulators.org/simulators/${encodeURIComponent(record.id)}/${encodeURIComponent(record.version)}`,
        extra: {
          version: record.version,
          algorithms: record.algorithms.map((algorithm) => ({
            kisao: algorithm.kisaoId.id,
            name: algorithm.name ?? algorithm.id,
            modelFormats: [...new Set(algorithm.modelFormats.map((format) => formats[format.id] ?? format.id))],
          })),
        },
      }))
  },

  async fetch(id, opts) {
    const parts = id.trim().split("/")
    if (parts.length > 2 || parts.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) {
      throw new Error("Use a BioSimulators identifier such as tellurium or tellurium/2.2.10")
    }
    const [name, version = "latest"] = parts
    const payload = await getJSON(
      `${API}/simulators/${encodeURIComponent(name!)}/${encodeURIComponent(version)}?includeTests=false`,
      { signal: opts?.signal },
    )
    const parsed = Simulator.safeParse(payload)
    if (!parsed.success || parsed.data.id !== name || (version !== "latest" && parsed.data.version !== version)) {
      throw new SourceResponseError("BioSimulators did not return the requested simulator record")
    }
    return payload
  },
}
