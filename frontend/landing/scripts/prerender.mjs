// Runs after the client and SSR builds. Writes one HTML file per page with
// its rendered content and the metadata the page declares through useMeta,
// plus 404.html, sitemap.xml and llms.txt.
import { readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const ssr = await import(pathToFileURL(resolve("dist-ssr/entry-server.js")).href)
const { render, ROUTES, CANONICAL, GITHUB, INSTALL_SCRIPT, NPM, SYNTHETIC_SCIENCES, X } = ssr

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Attributes may be split across lines in index.html, hence \s+. Replacements
// go through functions so `$` in a value isn't read as a group reference.
const TAGS = [
  [/(<title>)[^<]*(<\/title>)/, "title"],
  [/(<meta\s+name="description"\s+content=")[^"]*(")/, "description"],
  [/(<link\s+rel="canonical"\s+href=")[^"]*(")/, "url"],
  [/(<meta\s+property="og:url"\s+content=")[^"]*(")/, "url"],
  [/(<meta\s+property="og:title"\s+content=")[^"]*(")/, "title"],
  [/(<meta\s+property="og:description"\s+content=")[^"]*(")/, "description"],
  [/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/, "title"],
  [/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, "description"],
]

function withHead(html, values) {
  return TAGS.reduce((out, [pattern, key]) => {
    if (!pattern.test(out)) throw new Error(`prerender: ${pattern} not found in index.html`)
    return out.replace(pattern, (_m, a, b) => `${a}${esc(values[key])}${b}`)
  }, html)
}

const template = await readFile(resolve("dist/index.html"), "utf8")
const slot = '<div id="root"></div>'
if (!template.includes(slot)) throw new Error(`prerender: ${slot} not found in dist/index.html`)

const pages = []
for (const path of Object.keys(ROUTES)) {
  const { html, meta } = render(path)
  if (!meta) throw new Error(`prerender: ${path} rendered without calling useMeta`)
  const url = path === "/" ? `${CANONICAL}/` : `${CANONICAL}${path}`
  const page = withHead(template, { ...meta, url }).replace(slot, () => `<div id="root">${html}</div>`)
  await writeFile(resolve(path === "/" ? "dist/index.html" : `dist${path}.html`), page)
  pages.push({ path, url, ...meta })
}

// Unknown paths get the landing page, as before, but with a 404 status.
const home = pages.find((p) => p.path === "/")
await writeFile(
  resolve("dist/404.html"),
  withHead(template, home).replace(slot, () => `<div id="root">${render("/").html}</div>`),
)

const urls = [...pages.map((p) => p.url), `${CANONICAL}/docs`]
await writeFile(
  resolve("dist/sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>\n    <loc>${u}</loc>\n  </url>`).join("\n")}
</urlset>
`,
)

await writeFile(
  resolve("dist/llms.txt"),
  `# OpenScience

> ${home.description} Open source under Apache 2.0, by Synthetic Sciences.

## Install

- \`curl -fsSL ${INSTALL_SCRIPT} | bash\`
- \`npm install -g @synsci/openscience\`
- Desktop apps for macOS, Windows and Linux: ${CANONICAL}/download

## Pages

${pages.map((p) => `- [${p.title.replace(/^OpenScience \| /, "")}](${p.url}): ${p.description}`).join("\n")}

## Documentation

- [Docs](${CANONICAL}/docs)
- [Docs for LLMs](${CANONICAL}/docs/llms.txt), and the [full text](${CANONICAL}/docs/llms-full.txt)

## Links

- [GitHub](${GITHUB})
- [npm](${NPM})
- [Synthetic Sciences](${SYNTHETIC_SCIENCES})
- [X](${X})
`,
)

await rm(resolve("dist-ssr"), { recursive: true, force: true })
console.log(`prerendered ${pages.length} pages and 404.html, wrote sitemap.xml and llms.txt`)
