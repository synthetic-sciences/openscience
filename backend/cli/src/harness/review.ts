import type { Hooks, Plugin } from "@synsci/plugin"
import path from "path"
import fs from "fs/promises"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { LLM } from "@/session/llm"
import { Log } from "@/util/log"
import { Budget } from "./budget"
import { Deliverables } from "./deliverables"
import { HarnessState } from "./state"

/**
 * The review unit: when the deliverable is a written report, one fresh-context
 * read of the request against the report before the turn may end, and one
 * continuation naming what the report does not address.
 *
 * A report graded by a reader is graded on coverage: the clauses of the
 * request, the groups and comparisons it names or implies, the readings a
 * reviewer of that kind of data expects beyond the primary result, and
 * whether each number has its code beside it. The lead that wrote the report
 * cannot see its own gaps; a reader with nothing but the request and the
 * report can. Fifty rubric-graded analyses lost most of their points to
 * omissions of exactly this kind, and none to the environment.
 *
 * The unit fires only for a report: a deliverable the request named that is
 * a text or markdown file of some length. A task whose outputs are code, data
 * or a proof never sees it. Once per session; the deliverables and acceptance
 * units have the floor first; off with `harness.review: false`.
 */
export namespace Review {
  /** A deliverable this unit reads: prose files of report length. */
  export const REPORT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst", ".tex"])
  export const MIN_WORDS = 400
  /** What the reviewer sees of a long report: enough for any real one. */
  export const REPORT_CHARS = 120_000
  export const REQUEST_CHARS = 30_000
  export const TIMEOUT_MS = 5 * 60_000
  export const COMPLETE = "COMPLETE"
  /** A second read happens only when the first found this many gaps and at
   * least this share of the time budget remains: one more pass over a list
   * the lead has just worked, not a loop. */
  export const SECOND_ROUND_GAPS = 3
  export const SECOND_ROUND_BUDGET_LEFT = 0.25
  export const MAX_ROUNDS = 2

  export type Report = { name: string; text: string }

  /** The words a request uses when the file it names is something written
   * rather than computed: the file's own name counts (`report.md`). */
  const WRITTEN =
    /\b(report|analys[ie]s|trace|write-?ups?|summar(?:y|ies)|documentation|protocol|notes|discussion|narrative|markdown|explanation|interpretation|methods|findings)\b/i

  /** Whether the request frames this deliverable as a written report. */
  export function written(request: string, name: string) {
    const base = path.basename(name)
    const lines = request.split("\n").filter((line) => line.includes(name) || line.includes(base))
    return WRITTEN.test([base.replace(/[_\-.]+/g, " "), ...lines].join("\n"))
  }

  /** Whether a file reads as prose of report length rather than as data: a
   * gene list, a table of numbers or an ordering are text files too, and a
   * reader has nothing to say about them. */
  export function prose(text: string) {
    // Code blocks and table rows are part of a report but not of its prose;
    // a real analysis is often half code by token count.
    const body = text
      .replace(/^\s{0,3}(`{3,}|~{3,})[\s\S]*?^\s{0,3}\1[^\n]*$/gm, "")
      .split("\n")
      .filter((line) => !/^\s*\|/.test(line))
      .join("\n")
    const tokens = body.split(/\s+/).filter(Boolean)
    if (tokens.length < MIN_WORDS) return false
    const words = tokens.filter((token) => /^[A-Za-z][a-z'’-]*[.,;:!?)\]"']*$/.test(token)).length
    if (words / tokens.length < 0.5) return false
    const sentences = body.match(/[A-Za-z][.!?]["')\]]*(?:\s|$)/g)?.length ?? 0
    return sentences >= 15
  }

  /** The report(s) among the deliverables: what the request framed as
   * written, read from where they landed, and prose on inspection. */
  export async function reports(roots: string[], deliverables: string[], request: string): Promise<Report[]> {
    const out: Report[] = []
    for (const name of deliverables) {
      if (!REPORT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue
      if (!written(request, name)) continue
      for (const root of roots) {
        const file = path.isAbsolute(name) ? name : path.join(root, name)
        const text = await fs.readFile(file, "utf8").catch(() => undefined)
        if (text === undefined) continue
        if (prose(text)) out.push({ name, text })
        break
      }
    }
    return out
  }

  /** The reviewer's verdict, as a list of gaps; empty when the report is complete. */
  export function gaps(verdict: string): string[] {
    const text = verdict.trim()
    if (!text || new RegExp(`^\\W*${COMPLETE}\\W*$`, "i").test(text)) return []
    const items = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(?:\d+[.)]|[-*•])\s+/.test(line))
      .map((line) => line.replace(/^(?:\d+[.)]|[-*•])\s+/, ""))
    return items.length ? items.slice(0, 12) : [text.slice(0, 600)]
  }

  export function render(items: string[], round = 1) {
    return [
      round === 1
        ? "[Review] A fresh-context reviewer read the request and the report you delivered and found these gaps, most important first:"
        : "[Review] The reviewer read the revised report against its earlier list and still finds these gaps:",
      ...items.map((item, index) => `${index + 1}. ${item}`),
      "Address each by adding to the report, not by rebuilding it: where the request specified a definition, grouping, threshold, test or scope you applied differently, compute it as written and keep your version beside it as a sensitivity analysis; where interpretation is thin or declined, write it (mechanism with a reference, meaning, translational implication, next experiment) as labelled hypotheses; where you withheld a conclusion, give the best-supported answer with its confidence; where a standard reading is absent, run it and add its code, table and numbers. Keep everything that is right, carry the direction, counts, entities and mechanism into the answer file, and finish.",
    ].join("\n")
  }

  /** An output beside the report: where it landed and, when small, what it says. */
  export type Other = { name: string; status: string; text?: string }
  export const OTHER_CHARS = 4_000

  export async function others(roots: string[], deliverables: string[], reports: Report[]): Promise<Other[]> {
    const named = new Set(reports.map((report) => report.name))
    const out: Other[] = []
    for (const name of deliverables) {
      if (named.has(name)) continue
      const found = await (async () => {
        for (const root of roots) {
          const file = path.isAbsolute(name) ? name : path.join(root, name)
          const stat = await fs.stat(file).catch(() => undefined)
          if (stat) return { file, stat }
        }
      })()
      if (!found) {
        out.push({ name, status: "missing" })
        continue
      }
      if (found.stat.isDirectory()) {
        out.push({ name, status: "directory" })
        continue
      }
      const text =
        found.stat.size <= OTHER_CHARS ? await fs.readFile(found.file, "utf8").catch(() => undefined) : undefined
      const printable = text !== undefined && !/[\u0000-\u0008\u000e-\u001f]/.test(text)
      out.push({ name, status: `exists, ${found.stat.size} bytes`, text: printable ? text : undefined })
    }
    return out
  }

  export function prompt(request: string, report: Report, others: Other[], earlier?: string[]) {
    return [
      "<request>",
      request.slice(0, REQUEST_CHARS),
      "</request>",
      "",
      `<report path="${report.name}">`,
      report.text.slice(0, REPORT_CHARS),
      "</report>",
      "",
      "<other-outputs>",
      ...(others.length
        ? others.map((other) =>
            other.text !== undefined
              ? `<output path="${other.name}" status="${other.status}">\n${other.text}\n</output>`
              : `<output path="${other.name}" status="${other.status}" />`,
          )
        : ["(none beside the report)"]),
      "</other-outputs>",
      ...(earlier?.length
        ? [
            "",
            "<earlier-review>",
            "The report was revised once after this list; check only whether each item below is now delivered, and list the ones that are not.",
            ...earlier.map((item, index) => `${index + 1}. ${item}`),
            "</earlier-review>",
          ]
        : []),
    ].join("\n")
  }
}

const log = Log.create({ service: "harness.review" })

export const ReviewUnit: Plugin = async () => {
  const hooks: Hooks = {
    async "loop.before_finish"(input, output) {
      // A missing deliverable or a failing check is the more specific thing
      // to say; the review reads the report once those are settled.
      if (output.message) return
      const state = HarnessState.get(input.sessionID)
      if (state.reviewRounds >= Review.MAX_ROUNDS || state.deliverablesFailing || !state.deliverables.length) return
      if (state.reviewRounds === 1) {
        const gaps = state.reviewGaps ?? []
        if (gaps.length < Review.SECOND_ROUND_GAPS) return
        const left = Budget.remaining(state, HarnessState.clock.now())
        if (left !== undefined && left < Review.SECOND_ROUND_BUDGET_LEFT) return
      }
      const session = await Session.get(input.sessionID).catch(() => undefined)
      if (!session || session.parentID) return
      const messages = await Session.messages({ sessionID: input.sessionID }).catch(() => [])
      const user = messages.find((message) => message.info.role === "user")
      if (!user || user.info.role !== "user") return
      const info = user.info
      const request = user.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
      if (!request.trim()) return
      const roots = await Deliverables.roots(input.sessionID)
      const reports = await Review.reports(roots, state.deliverables, request)
      if (!reports.length) return
      const agent = await Agent.get("reader")
      if (!agent) return
      const model = await Provider.getModel(info.model.providerID, info.model.modelID).catch(() => undefined)
      if (!model) return
      // One read covers the reports together: a trace and its answer are one
      // deliverable to a grader.
      const report =
        reports.length === 1
          ? reports[0]
          : {
              name: reports.map((r) => r.name).join(" + "),
              text: reports.map((r) => `# ${r.name}\n\n${r.text}`).join("\n\n"),
            }
      const others = await Review.others(roots, state.deliverables, reports)
      const earlier = state.reviewRounds === 1 ? state.reviewGaps : undefined
      state.reviewRounds++
      const verdict = await Provider.withRequestContext(
        { sessionID: input.sessionID, messageID: `review:${input.messageID}`, attempt: 0 },
        async () => {
          const stream = await LLM.stream({
            agent,
            user: { ...info, system: undefined },
            tools: {},
            model,
            messages: [{ role: "user" as const, content: Review.prompt(request, report, others, earlier) }],
            abort: AbortSignal.timeout(Review.TIMEOUT_MS),
            sessionID: input.sessionID,
            system: [],
            retries: 0,
          })
          return stream.text
        },
      ).catch((error) => {
        log.warn("review call failed; the report stands", { sessionID: input.sessionID, error })
        return Review.COMPLETE
      })
      const items = Review.gaps(verdict)
      state.reviewGaps = items
      log.info("review", {
        sessionID: input.sessionID,
        report: report.name,
        round: state.reviewRounds,
        gaps: items.length,
      })
      if (!items.length) return
      output.message = Review.render(items, state.reviewRounds)
    },
    async event({ event }) {
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
    },
  }
  return hooks
}
