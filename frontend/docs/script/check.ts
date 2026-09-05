import path from "node:path"
import { Config } from "../../../backend/cli/src/config/config"
import { RunEvents } from "../../../backend/cli/src/cli/run-events"
import { aliases, headings, parseRoute, resolveLink, slug } from "../src/navigation"
import config from "../src/content/openscience/docs.json"

const root = path.resolve(import.meta.dir, "../../..")
const directory = path.join(root, "frontend/docs/src/content/openscience")
const files = Array.from(new Bun.Glob("*.mdx").scanSync({ cwd: directory })).sort()
const pages = new Map<string, { body: string; headings: string[] }>()
const errors: string[] = []
const counts = { examples: 0, links: 0 }
const report = (file: string, message: string) => errors.push(file + ": " + message)

for (const file of files) {
  const source = await Bun.file(path.join(directory, file)).text()
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!frontmatter || !/^title: ".+"$/m.test(frontmatter[1]) || !/^description: ".+"$/m.test(frontmatter[1])) {
    report(file, "Expected a quoted title and description in frontmatter")
  }
  const body = source.slice(frontmatter?.[0].length ?? 0)
  const sections = headings(body, 3).map(slug)
  if (new Set(sections).size !== sections.length) report(file, "Duplicate heading anchors")
  pages.set(file.replace(/\.mdx$/, ""), { body, headings: sections })
  for (const match of body.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const value: unknown = JSON.parse(match[1])
    const schema = file === "automation.mdx" ? RunEvents.Event : Config.Info
    const result = schema.safeParse(value)
    if (!result.success) report(file, "Invalid JSON example: " + result.error.message)
    counts.examples++
  }
}

const order = config.navigation.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.pages))
for (const page of order) if (!pages.has(page)) report("docs.json", "Missing page " + page)
if (new Set(order).size !== order.length) report("docs.json", "A page is listed more than once")
for (const page of pages.keys()) if (!order.includes(page)) report(page, "Page is missing from navigation")
for (const [alias, target] of Object.entries(aliases)) {
  if (!pages.has(target)) report(alias, "Missing redirect target " + target)
  if (pages.has(alias)) report(alias, "A legacy redirect shadows this page; choose a different page path")
}

for (const [page, document] of pages) {
  const prose = document.body.replace(/```[\s\S]*?```/g, "")
  const links = [
    ...Array.from(prose.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g), (match) => match[1]),
    ...Array.from(prose.matchAll(/href="([^"]+)"/g), (match) => match[1]),
  ]
  for (const href of links) {
    counts.links++
    if (/^(https?:|mailto:)/.test(href)) {
      const url = new URL(href)
      if (url.hostname === "github.com" && /^\/synthetic-sciences\/openscience\/blob\/main\//i.test(url.pathname)) {
        const relative = decodeURIComponent(url.pathname.split("/blob/main/")[1])
        if (!(await Bun.file(path.join(root, relative)).exists())) report(page, "Missing repository file " + relative)
      }
      continue
    }
    const route = parseRoute(resolveLink(href, { section: "openscience", path: page }) ?? "")
    const target = pages.get(route.path)
    if (!target) report(page, "Broken link " + href)
    else if (route.anchor && !target.headings.includes(route.anchor)) report(page, "Missing section " + href)
  }
}
if (errors.length) throw new Error(errors.join("\n"))
console.log(
  "Validated " +
    pages.size +
    " pages, " +
    counts.links +
    " links, and " +
    counts.examples +
    " JSON examples against the product schemas.",
)
