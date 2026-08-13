import path from "node:path"
import { mkdir, readFile, rename } from "node:fs/promises"

export type CampaignPrompt = {
  id: string
  ordinal: number
  title: string
  text: string
  sha256: string
  batchIndex: number
  batchPosition: number
  source: "rtf" | "report"
}

const DEFAULT_CAMPAIGN = path.join(import.meta.dir, "campaigns", "cadence-cloud-20")

function flags(tokens: string[]) {
  const output = new Map<string, string>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith("--")) continue
    const value = tokens[index + 1]
    if (!value || value.startsWith("--")) continue
    output.set(token.slice(2), value)
    index += 1
  }
  return output
}

function sha256(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function requiredPath(input: Map<string, string>, name: string) {
  const value = input.get(name)
  if (!value) throw new Error(`Missing required --${name} <path>`)
  return path.resolve(value)
}

function cleanMarkdown(value: string) {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim()
}

export function extractPrompts(text: string, source: CampaignPrompt["source"]) {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  const output = new Map<number, Omit<CampaignPrompt, "sha256" | "batchIndex" | "batchPosition">>()
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]?.trim().replace(/^\*\*/, "").replace(/\*\*$/, "")
    const match = header?.match(/^P(\d{1,2})\s+→\s+(.+)$/)
    if (!match) continue
    const ordinal = Number(match[1])
    if (ordinal < 1 || ordinal > 20) continue
    if (output.has(ordinal)) throw new Error(`Prompt P${ordinal} appears more than once in the ${source} source`)
    const body = lines.slice(index + 1).find((line) => line.trim().length > 0)
    if (!body) continue
    output.set(ordinal, {
      id: `P${ordinal}`,
      ordinal,
      title: cleanMarkdown(match[2]!),
      text: cleanMarkdown(body),
      source,
    })
  }
  return output
}

export function buildPromptCorpus(rtf: string, report: string): CampaignPrompt[] {
  const prompts = extractPrompts(rtf, "rtf")
  // The supplied RTF begins at P2. Carry only the missing first prompt from
  // the attached report so the fixed twenty-prompt order remains complete.
  const reportPrompts = extractPrompts(report, "report")
  if (!prompts.has(1) && reportPrompts.has(1)) prompts.set(1, reportPrompts.get(1)!)
  return Array.from({ length: 20 }, (_, offset) => offset + 1).map((ordinal) => {
    const prompt = prompts.get(ordinal)
    if (!prompt) throw new Error(`Prompt P${ordinal} is missing from the segregated corpus`)
    return {
      ...prompt,
      sha256: sha256(prompt.text),
      batchIndex: Math.floor((ordinal - 1) / 3) + 1,
      batchPosition: (ordinal - 1) % 3,
    }
  })
}

async function rtfText(file: string) {
  const process = Bun.spawn(["textutil", "-convert", "txt", "-stdout", file], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`textutil failed (${exitCode}): ${stderr.trim()}`)
  return stdout
}

async function writeAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  await Bun.write(temporary, JSON.stringify(value, null, 2) + "\n")
  await rename(temporary, file)
}

async function main() {
  const input = flags(Bun.argv.slice(2))
  const rtf = requiredPath(input, "rtf")
  const report = requiredPath(input, "report")
  const campaignRoot = path.resolve(input.get("campaign") ?? DEFAULT_CAMPAIGN)
  const [rtfBytes, reportBytes, converted] = await Promise.all([readFile(rtf), readFile(report), rtfText(rtf)])
  const ordered = buildPromptCorpus(converted, reportBytes.toString("utf8"))
  const campaignID = path.basename(campaignRoot)
  const now = new Date().toISOString()
  await mkdir(path.join(campaignRoot, "runs"), { recursive: true })
  await mkdir(path.join(campaignRoot, "batches"), { recursive: true })
  await writeAtomic(path.join(campaignRoot, "prompts.json"), {
    schemaVersion: 1,
    campaignID,
    count: ordered.length,
    batches: 7,
    source: {
      rtf: { path: rtf, sha256: sha256(rtfBytes), bytes: rtfBytes.byteLength },
      report: {
        path: report,
        sha256: sha256(reportBytes),
        bytes: reportBytes.byteLength,
        role: "P1 fallback and context",
      },
    },
    prompts: ordered,
  })
  const campaignFile = path.join(campaignRoot, "campaign.json")
  const existingCampaign = await Bun.file(campaignFile)
    .json()
    .catch(() => undefined)
  await writeAtomic(campaignFile, {
    ...(existingCampaign && typeof existingCampaign === "object" ? existingCampaign : {}),
    schemaVersion: 1,
    id: campaignID,
    title: "OpenScience harness trajectory campaign · 20 scientific prompts",
    status: existingCampaign?.status ?? "pending",
    plannedPrompts: 20,
    batchSizes: [3, 3, 3, 3, 3, 3, 2],
    sourceLabel: "Untitled.rtf (P2–P20) + attached report (P1)",
    createdAt: existingCampaign?.createdAt ?? now,
    updatedAt: now,
  })
  const backlog = path.join(campaignRoot, "BETTER_SEARCH_PARALLEL.md")
  if (!(await Bun.file(backlog).exists())) {
    await Bun.write(
      backlog,
      `# Better search and parallelism backlog\n\nUpdated after each three-run batch. Items stay here when the trajectory suggests a broader design opportunity but the evidence is not yet strong enough for an immediate harness change.\n\n| ID | Area | Status | Severity | Confidence | First/last batch | Evidence runs | General mechanism | Deferred reason | Next experiment |\n|---|---|---|---|---|---|---|---|---|---|\n\n## Search and retrieval\n\n## Parallelism and delegation\n`,
    )
  }
  console.log(`Prepared ${ordered.length} prompts in 7 batches at ${campaignRoot}`)
}

if (import.meta.main) await main()
