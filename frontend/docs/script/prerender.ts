// Runs after the client and SSR builds. Writes every page to dist/<page>.html
// with its own title, description, canonical URL and JSON-LD, plus 404.html
// for unknown paths and sitemap.xml, so each page can be indexed on its own.
import path from "node:path"
import { BASE, SITE, documentTitle, pageUrl } from "../src/navigation"

type Page = { path: string; title: string; description: string }
type Group = { group: string; pages: Array<string | Group> }

const dist = path.resolve(import.meta.dir, "../dist")
const ssr = await import(path.resolve(import.meta.dir, "../dist-ssr/entry-server.js"))
const render: (path: string) => string = ssr.render
const pages: Record<string, Page> = ssr.DOC_PAGES
const config: { navigation: { tabs: { groups: Group[] }[] } } = ssr.DOC_CONFIG

const flatten = (items: Array<string | Group>): string[] =>
  items.flatMap((item) => (typeof item === "string" ? [item] : flatten(item.pages)))
const order = config.navigation.tabs.flatMap((tab) => tab.groups.flatMap((group) => flatten(group.pages)))

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Attributes may be split across lines in index.html, hence \s+. Replacements go
// through functions so `$` in a value isn't read as a group reference.
const TAGS: Array<[RegExp, "title" | "description" | "url"]> = [
  [/(<title>)[^<]*(<\/title>)/, "title"],
  [/(<meta\s+name="description"\s+content=")[^"]*(")/, "description"],
  [/(<link\s+rel="canonical"\s+href=")[^"]*(")/, "url"],
  [/(<meta\s+property="og:url"\s+content=")[^"]*(")/, "url"],
  [/(<meta\s+property="og:title"\s+content=")[^"]*(")/, "title"],
  [/(<meta\s+property="og:description"\s+content=")[^"]*(")/, "description"],
  [/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/, "title"],
  [/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, "description"],
]

function withHead(html: string, values: Record<"title" | "description" | "url", string>): string {
  return TAGS.reduce((out, [pattern, key]) => {
    if (!pattern.test(out)) throw new Error(`prerender: ${pattern} not found in index.html`)
    return out.replace(pattern, (_match, before: string, after: string) => before + esc(values[key]) + after)
  }, html)
}

function structuredData(page: Page, title: string): string {
  const url = pageUrl(page.path)
  const crumbs = [
    { name: "OpenScience", item: SITE + "/" },
    { name: "Docs", item: SITE + BASE },
    ...(page.path === "index" ? [] : [{ name: page.title, item: url }]),
  ]
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": page.path === "index" ? "CollectionPage" : "TechArticle",
        "@id": url + "#page",
        headline: page.title,
        name: title,
        description: page.description,
        url,
        inLanguage: "en",
        isPartOf: { "@id": SITE + "/#website" },
        about: { "@type": "SoftwareApplication", name: "OpenScience", url: SITE + "/" },
        publisher: { "@type": "Organization", name: "Synthetic Sciences", url: "https://syntheticsciences.ai/" },
        breadcrumb: { "@id": url + "#breadcrumb" },
      },
      {
        "@type": "BreadcrumbList",
        "@id": url + "#breadcrumb",
        itemListElement: crumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, ...crumb })),
      },
    ],
  }
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`
}

// Fails the build rather than shipping a page that breaks the on-page rules.
function check(name: string, html: string, title: string, description: string) {
  const h1s = (html.slice(html.indexOf("<body")).match(/<h1[\s>]/g) ?? []).length
  const problems = [
    title.length > 60 && `title is ${title.length} characters (max 60)`,
    (!description || description.length > 155) && `description is ${description.length} characters (max 155)`,
    h1s !== 1 && `${h1s} h1 elements (want 1)`,
  ].filter(Boolean)
  if (problems.length) throw new Error(`prerender: ${name}: ${problems.join("; ")}`)
}

const template = await Bun.file(path.join(dist, "index.html")).text()
const slot = '<div id="root"></div>'
if (!template.includes(slot)) throw new Error(`prerender: ${slot} not found in dist/index.html`)

for (const name of order) {
  const page = pages[name]
  if (!page) throw new Error(`prerender: docs.json lists ${name}, which has no page`)
  const title = documentTitle(page.title, name)
  const html = withHead(template, { title, description: page.description, url: pageUrl(name) })
    .replace("</head>", () => structuredData(page, title) + "\n  </head>")
    .replace(slot, () => `<div id="root">${render(BASE + "/" + name)}</div>`)
  check(name, html, title, page.description)
  await Bun.write(path.join(dist, name === "index" ? "index.html" : name + ".html"), html)
}

// Unknown /docs paths are rewritten here by the site's vercel.json.
const missing = withHead(template, {
  title: documentTitle("Page not found"),
  description: "This documentation page does not exist or has moved.",
  url: SITE + BASE,
})
  .replace(
    /(<meta\s+name="robots"\s+content=")[^"]*(")/,
    (_match, before: string, after: string) => before + "noindex" + after,
  )
  .replace(slot, () => `<div id="root">${render(BASE + "/404")}</div>`)
await Bun.write(path.join(dist, "404.html"), missing)

await Bun.write(
  path.join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${order.map((name) => `  <url>\n    <loc>${pageUrl(name)}</loc>\n  </url>`).join("\n")}
</urlset>
`,
)
console.log(`Prerendered ${order.length} documentation pages, 404.html and sitemap.xml.`)
