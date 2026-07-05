import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  FlaskConical,
  GitBranch,
  Layers,
  Moon,
  PackageCheck,
  Rocket,
  Search,
  ShieldCheck,
  Star,
  Sun,
  Terminal,
} from "lucide-react"
import { useTheme } from "./theme"

const mono = `"JetBrains Mono", "SF Mono", ui-monospace, monospace`

const DOCS_SERIF = `"Computer Modern Concrete", "Concrete Roman", Georgia, "Times New Roman", serif`

type DocsConfig = {
  name?: string
  navigation: {
    tabs: Array<{
      tab: string
      groups: Array<{
        group: string
        pages: Array<string | { group: string; pages: string[] }>
      }>
    }>
    global?: {
      anchors?: Array<{
        anchor: string
        href: string
      }>
    }
  }
  navbar?: {
    links?: Array<{
      label: string
      href: string
    }>
    primary?: {
      label: string
      href: string
    }
  }
}

type DocsPage = {
  path: string
  title: string
  description: string
  icon: ReactNode
  body: string
  headings: string[]
}

type SearchResult = Pick<DocsPage, "path" | "title" | "description" | "icon"> & {
  section: SectionKey
  sectionLabel: string
}

type MintlifyCard = {
  title: string
  href: string
  icon?: string
  body: string
  horizontal?: boolean
}

type SectionKey = "openscience"

type Section = {
  key: SectionKey
  label: string
  short: string
  tagline: string
  lead: boolean
}

const SECTIONS: Section[] = [
  { key: "openscience", label: "OpenScience", short: "OpenScience", tagline: "Open-source AI workbench", lead: false },
]

const SECTION_KEYS = SECTIONS.map((section) => section.key)

// All MDX content and per-section configs, loaded at build time. Adding a page is
// just dropping an .mdx file into the right content/<section>/ folder.
const RAW_PAGES = import.meta.glob("./content/**/*.{mdx,md}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

const RAW_CONFIGS = import.meta.glob("./content/**/docs.json", {
  import: "default",
  eager: true,
}) as Record<string, DocsConfig>

const ICONS: Record<string, ReactNode> = {
  index: <GitBranch size={17} strokeWidth={1.8} />,
  quickstart: <Rocket size={17} strokeWidth={1.8} />,
  workspace: <Layers size={17} strokeWidth={1.8} />,
  agents: <Bot size={17} strokeWidth={1.8} />,
  models: <PackageCheck size={17} strokeWidth={1.8} />,
  skills: <BookOpen size={17} strokeWidth={1.8} />,
  sessions: <Terminal size={17} strokeWidth={1.8} />,
  atlas: <GitBranch size={17} strokeWidth={1.8} />,
  commands: <Terminal size={17} strokeWidth={1.8} />,
  security: <ShieldCheck size={17} strokeWidth={1.8} />,
}

const SECTION_FALLBACK_ICON: Record<SectionKey, ReactNode> = {
  openscience: <FlaskConical size={17} strokeWidth={1.8} />,
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/

function parseFrontmatter(source: string): { title: string; description: string; body: string } {
  const match = source.match(FRONTMATTER_RE)
  if (!match) return { title: "Untitled", description: "", body: source }
  const frontmatter = match[1]
  const body = source.slice(match[0].length)
  const field = (name: string) => {
    const line = frontmatter.split("\n").find((entry) => entry.trim().startsWith(`${name}:`))
    return line
      ? line
          .split(":")
          .slice(1)
          .join(":")
          .trim()
          .replace(/^["']|["']$/g, "")
      : ""
  }
  return {
    title: field("title") || "Untitled",
    description: field("description"),
    body,
  }
}

function extractHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.replace(/^##\s+/, "").trim())
    .slice(0, 10)
}

function flattenPages(items: Array<string | { group: string; pages: string[] }>): string[] {
  return items.flatMap((item) => (typeof item === "string" ? [item] : item.pages))
}

function iconForPath(path: string, section: SectionKey): ReactNode {
  const leaf = path.split("/").pop() ?? path
  return ICONS[path] ?? ICONS[leaf] ?? SECTION_FALLBACK_ICON[section]
}

function buildSectionPages(section: SectionKey): Record<string, DocsPage> {
  const prefix = `./content/${section}/`
  const pages: Record<string, DocsPage> = {}
  for (const [key, source] of Object.entries(RAW_PAGES)) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length).replace(/\.(mdx|md)$/, "")
    const parsed = parseFrontmatter(source)
    pages[path] = {
      path,
      title: parsed.title,
      description: parsed.description,
      icon: iconForPath(path, section),
      body: parsed.body,
      headings: extractHeadings(parsed.body),
    }
  }
  return pages
}

const SECTION_DOC_PAGES: Record<SectionKey, Record<string, DocsPage>> = {
  openscience: buildSectionPages("openscience"),
}

const SECTION_CONFIGS: Record<SectionKey, DocsConfig> = {
  openscience: RAW_CONFIGS["./content/openscience/docs.json"],
}

function pageExists(section: SectionKey, path: string): boolean {
  return Boolean(SECTION_DOC_PAGES[section]?.[path])
}

// Retired first URL segments that redirect into the openscience scheme.
const SECTION_ALIASES: Record<string, SectionKey> = {
  "agent-cli": "openscience",
}

// Old CLI page names that moved during the OpenScience rebuild.
const PAGE_ALIASES: Record<string, string> = {
  "first-session": "sessions",
  "sub-agents": "agents",
  "web-ui": "workspace",
  credentials: "atlas",
}

// Redirects from the oldest single-segment URLs to the #/<section>/<page> scheme.
const LEGACY_REDIRECTS: Record<string, { section: SectionKey; path: string }> = {
  "cli:index": { section: "openscience", path: "index" },
  "cli:installation": { section: "openscience", path: "quickstart" },
  "cli:quickstart": { section: "openscience", path: "quickstart" },
  "cli:first-session": { section: "openscience", path: "sessions" },
  "cli:sessions": { section: "openscience", path: "sessions" },
  "cli:models": { section: "openscience", path: "models" },
  "cli:codex": { section: "openscience", path: "models" },
  "cli:sub-agents": { section: "openscience", path: "agents" },
  "cli:skills": { section: "openscience", path: "skills" },
  "cli:cli-runtime": { section: "openscience", path: "commands" },
  "cli:connect": { section: "openscience", path: "atlas" },
  "cli:credentials": { section: "openscience", path: "atlas" },
  "cli:security": { section: "openscience", path: "security" },
  "cli:feature-map": { section: "openscience", path: "commands" },
  "cli:commands": { section: "openscience", path: "commands" },
  "cli:web-ui": { section: "openscience", path: "workspace" },
  "cli:server-mode": { section: "openscience", path: "workspace" },
}

type Route = { section: SectionKey; path: string }

function defaultRoute(): Route {
  return { section: "openscience", path: "index" }
}

function routeFromHash(): Route {
  if (typeof window === "undefined") return defaultRoute()
  const raw = decodeURIComponent(window.location.hash.replace(/^#\/?/, "")).replace(/\/$/, "")
  if (!raw) return defaultRoute()
  const segments = raw.split("/")
  const maybeSection = segments[0] as SectionKey
  if (SECTION_KEYS.includes(maybeSection)) {
    const path = segments.slice(1).join("/") || "index"
    if (pageExists(maybeSection, path)) return { section: maybeSection, path }
    return { section: maybeSection, path: "index" }
  }
  // Retired section names redirect into the openscience scheme.
  const aliasSection = SECTION_ALIASES[segments[0]]
  if (aliasSection) {
    const rawPath = segments.slice(1).join("/") || "index"
    const path = PAGE_ALIASES[rawPath] ?? rawPath
    if (pageExists(aliasSection, path)) return { section: aliasSection, path }
    return { section: aliasSection, path: "index" }
  }
  // Legacy single-segment URL from the old CLI docs.
  const redirect = LEGACY_REDIRECTS[`cli:${raw}`]
  if (redirect && pageExists(redirect.section, redirect.path)) return redirect
  return defaultRoute()
}

function pageHref(section: SectionKey, path: string): string {
  return `#/${section}/${path}`
}

// Module-level pointers updated on each render so the markdown renderer (which
// can't take props through react-markdown) can resolve links and card icons.
let CURRENT_SECTION: SectionKey = "openscience"

function resolveHref(href: string | undefined): string | undefined {
  if (!href) return href
  if (href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:")) return href
  if (href.startsWith("/")) {
    const clean = href.slice(1).replace(/\/$/, "")
    if (!clean) return pageHref(CURRENT_SECTION, "index")
    const segments = clean.split("/")
    const maybeSection = segments[0] as SectionKey
    if (SECTION_KEYS.includes(maybeSection)) {
      const path = segments.slice(1).join("/") || "index"
      if (pageExists(maybeSection, path)) return pageHref(maybeSection, path)
    }
    if (pageExists(CURRENT_SECTION, clean)) return pageHref(CURRENT_SECTION, clean)
  }
  return href
}

function sectionForHref(href: string): SectionKey {
  const clean = href.replace(/^#\/?/, "").replace(/\/$/, "")
  const segments = clean.split("/")
  const maybeSection = segments[0] as SectionKey
  return SECTION_KEYS.includes(maybeSection) ? maybeSection : CURRENT_SECTION
}

function parseMdxAttrs(attrs: string): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {}
  for (const match of attrs.matchAll(/([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g)) {
    const key = match[1]
    if (!key) continue
    parsed[key] = match[2] ?? match[3] ?? match[4] ?? true
  }
  return parsed
}

function dedent(source: string): string {
  const lines = source.replace(/\t/g, "  ").split("\n")
  let min = Infinity
  for (const line of lines) {
    if (line.trim() === "") continue
    const leading = line.match(/^( *)/)
    if (leading) min = Math.min(min, leading[1].length)
  }
  if (!Number.isFinite(min) || min === 0) return source
  return lines.map((line) => (line.length >= min ? line.slice(min) : line)).join("\n")
}

function parseCards(source: string): MintlifyCard[] {
  return Array.from(source.matchAll(/<Card\b([^>]*)>\s*([\s\S]*?)\s*<\/Card>/g)).map((match) => {
    const attrs = parseMdxAttrs(match[1] ?? "")
    return {
      title: String(attrs.title ?? "Untitled"),
      href: String(attrs.href ?? "#"),
      icon: attrs.icon ? String(attrs.icon) : undefined,
      horizontal: Boolean(attrs.horizontal),
      body: dedent(match[2] ?? "").trim(),
    }
  })
}

function iconForCard(card: MintlifyCard): ReactNode {
  const resolved = resolveHref(card.href)
  if (resolved && resolved.startsWith("#/")) {
    const section = sectionForHref(resolved)
    const path = resolved.replace(/^#\/?/, "").replace(/\/$/, "").split("/").slice(1).join("/")
    const page = SECTION_DOC_PAGES[section]?.[path]
    if (page) return page.icon
  }
  return <BookOpen size={17} strokeWidth={1.8} />
}

const OPENSCIENCE_REPO = "synthetic-sciences/openscience"

function formatStars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(count)
}

function GitHubStars() {
  const [stars, setStars] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const cacheKey = `docs-gh-stars:${OPENSCIENCE_REPO}`
    try {
      const cached = JSON.parse(window.localStorage.getItem(cacheKey) ?? "null") as { stars: number; at: number } | null
      if (cached && Date.now() - cached.at < 60 * 60 * 1000) {
        setStars(cached.stars)
        return
      }
    } catch {
      /* ignore */
    }
    fetch(`https://api.github.com/repos/${OPENSCIENCE_REPO}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { stargazers_count?: number } | null) => {
        const count = data?.stargazers_count
        if (typeof count !== "number" || cancelled) return
        setStars(count)
        try {
          window.localStorage.setItem(cacheKey, JSON.stringify({ stars: count, at: Date.now() }))
        } catch {
          /* ignore */
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="docs-ghstars">
      <a
        className="docs-ghstars-primary"
        href={`https://github.com/${OPENSCIENCE_REPO}`}
        target="_blank"
        rel="noreferrer"
      >
        <Star size={13} strokeWidth={1.8} />
        <span>Star on GitHub</span>
        {stars !== null ? <em>{formatStars(stars)}</em> : null}
      </a>
      <a href={`https://github.com/${OPENSCIENCE_REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
        Apache-2.0
      </a>
      <a href="https://www.npmjs.com/package/@synsci/openscience" target="_blank" rel="noreferrer">
        npm · @synsci/openscience
      </a>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="docs-copy"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      aria-label="copy code"
      title="copy code"
    >
      {copied ? <Check size={13} strokeWidth={1.8} /> : <Copy size={13} strokeWidth={1.8} />}
      <span>{copied ? "copied" : "copy"}</span>
    </button>
  )
}

const markdownComponents: Components = {
  h2({ children }) {
    const id = String(children)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
    return <h2 id={id}>{children}</h2>
  },
  a({ href, children }) {
    const external = href?.startsWith("http")
    const internalDocsHref = href ? resolveHref(href) : undefined
    return (
      <a href={internalDocsHref} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined}>
        {children}
        {external ? <ArrowUpRight size={12} strokeWidth={1.8} /> : null}
      </a>
    )
  },
  pre({ children }) {
    const text = extractCodeText(children)
    return (
      <div className="docs-code-wrap">
        <CopyButton text={text} />
        <pre>{children}</pre>
      </div>
    )
  },
  code({ className, children }) {
    const isBlock = className?.startsWith("language-")
    return <code className={isBlock ? className : "docs-inline-code"}>{children}</code>
  },
  table({ children }) {
    return (
      <div className="docs-table-wrap">
        <table>{children}</table>
      </div>
    )
  },
  blockquote({ children }) {
    return <blockquote className="docs-callout">{children}</blockquote>
  },
}

function extractCodeText(node: ReactNode): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(extractCodeText).join("")
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return extractCodeText(props?.children ?? "")
  }
  return ""
}

function MarkdownChunk({ children }: { children: string }) {
  if (!children.trim()) return null
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  )
}

function MintlifyCardView({ card }: { card: MintlifyCard }) {
  const external = card.href.startsWith("http")
  return (
    <a
      className={card.horizontal ? "docs-card docs-card-horizontal" : "docs-card"}
      href={resolveHref(card.href)}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      <span className="docs-card-icon">{iconForCard(card)}</span>
      <span className="docs-card-copy">
        <strong>{card.title}</strong>
        <small>{card.body}</small>
      </span>
      <ArrowUpRight size={14} strokeWidth={1.8} />
    </a>
  )
}

function MintlifyCardGrid({ source, cols }: { source: string; cols: number }) {
  const cards = parseCards(source)
  if (cards.length === 0) return null
  return (
    <div className="docs-card-grid" style={{ "--docs-card-cols": String(cols) } as CSSProperties}>
      {cards.map((card) => (
        <MintlifyCardView key={`${card.title}-${card.href}`} card={card} />
      ))}
    </div>
  )
}

function MintlifySteps({ source }: { source: string }) {
  const steps = Array.from(source.matchAll(/<Step\s+([^>]*)>\s*([\s\S]*?)\s*<\/Step>/g)).map((match) => {
    const attrs = parseMdxAttrs(match[1] ?? "")
    return {
      title: String(attrs.title ?? "Step"),
      body: dedent(match[2] ?? "").trim(),
    }
  })
  if (steps.length === 0) return null
  return (
    <div className="docs-step-list">
      {steps.map((step, index) => (
        <section key={`${step.title}-${index}`} className="docs-step">
          <span>{index + 1}</span>
          <div>
            <h3>{step.title}</h3>
            <MarkdownChunk>{step.body}</MarkdownChunk>
          </div>
        </section>
      ))}
    </div>
  )
}

function MintlifyCallout({ children }: { children: string }) {
  return (
    <blockquote className="docs-callout docs-callout-warning">
      <MarkdownChunk>{dedent(children).trim()}</MarkdownChunk>
    </blockquote>
  )
}

function renderMintlifyContent(source: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const componentRe =
    /<(Columns|CardGroup)\b([^>]*)>\s*([\s\S]*?)\s*<\/\1>|<Card\b([^>]*)>\s*([\s\S]*?)\s*<\/Card>|<Steps>\s*([\s\S]*?)\s*<\/Steps>|<Warning>\s*([\s\S]*?)\s*<\/Warning>|<GitHubStars\s*\/>/g
  let lastIndex = 0
  let index = 0

  for (const match of source.matchAll(componentRe)) {
    const matchIndex = match.index ?? 0
    const before = source.slice(lastIndex, matchIndex)
    if (before.trim()) nodes.push(<MarkdownChunk key={`md-${index++}`}>{before}</MarkdownChunk>)

    if (match[1]) {
      const attrs = parseMdxAttrs(match[2] ?? "")
      const cols = Number(attrs.cols ?? 2)
      nodes.push(
        <MintlifyCardGrid
          key={`cards-${index++}`}
          source={match[3] ?? ""}
          cols={Number.isFinite(cols) && cols > 0 ? cols : 2}
        />,
      )
    } else if (match[4] !== undefined) {
      const card = parseCards(`<Card ${match[4]}>${match[5] ?? ""}</Card>`)[0]
      if (card) nodes.push(<MintlifyCardView key={`card-${index++}`} card={card} />)
    } else if (match[6] !== undefined) {
      nodes.push(<MintlifySteps key={`steps-${index++}`} source={match[6] ?? ""} />)
    } else if (match[7] !== undefined) {
      nodes.push(<MintlifyCallout key={`warning-${index++}`}>{match[7] ?? ""}</MintlifyCallout>)
    } else if (match[0].startsWith("<GitHubStars")) {
      nodes.push(<GitHubStars key={`ghstars-${index++}`} />)
    }

    lastIndex = matchIndex + match[0].length
  }

  const tail = source.slice(lastIndex)
  if (tail.trim()) nodes.push(<MarkdownChunk key={`md-${index++}`}>{tail}</MarkdownChunk>)
  return nodes
}

export function DocumentationPage() {
  const { theme, toggle: toggleTheme } = useTheme()
  const [route, setRouteState] = useState<Route>(() => routeFromHash())
  const section = route.section
  CURRENT_SECTION = section
  const docPages = SECTION_DOC_PAGES[section]
  const config = SECTION_CONFIGS[section]
  const sectionMeta = SECTIONS.find((entry) => entry.key === section) ?? SECTIONS[0]
  const activePage = docPages[route.path] ?? docPages.index
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)

  const navTabs = config.navigation.tabs
  const orderedPaths = useMemo(
    () =>
      navTabs
        .flatMap((tab) => tab.groups.flatMap((group) => flattenPages(group.pages)))
        .filter((path) => docPages[path]),
    [navTabs, docPages],
  )
  const activeTab = useMemo(
    () =>
      navTabs.find((tab) => tab.groups.some((group) => flattenPages(group.pages).includes(activePage.path))) ??
      navTabs[0],
    [activePage.path, navTabs],
  )
  const activeGroup = useMemo(
    () => activeTab?.groups.find((group) => flattenPages(group.pages).includes(activePage.path)),
    [activePage.path, activeTab],
  )
  const activeIndex = orderedPaths.indexOf(activePage.path)
  const previousPage = activeIndex > 0 ? docPages[orderedPaths[activeIndex - 1]] : null
  const nextPage =
    activeIndex >= 0 && activeIndex < orderedPaths.length - 1 ? docPages[orderedPaths[activeIndex + 1]] : null

  // Search spans every section so people can jump anywhere from one box.
  const searchResults = useMemo<SearchResult[]>(() => {
    const all: SearchResult[] = SECTIONS.flatMap((entry) => {
      const pages = SECTION_CONFIGS[entry.key].navigation.tabs
        .flatMap((tab) => tab.groups.flatMap((group) => flattenPages(group.pages)))
        .map((path) => SECTION_DOC_PAGES[entry.key][path])
        .filter(Boolean)
      return pages.map((page) => ({
        path: page.path,
        title: page.title,
        description: page.description,
        icon: page.icon,
        section: entry.key,
        sectionLabel: entry.label,
      }))
    })
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return all.filter((page) => page.section === section).slice(0, 6)
    }
    return all
      .filter((page) => {
        const body = SECTION_DOC_PAGES[page.section][page.path]?.body ?? ""
        const haystack = `${page.title} ${page.description} ${page.sectionLabel} ${body}`.toLowerCase()
        return haystack.includes(normalizedQuery)
      })
      .slice(0, 8)
  }, [query, section])

  const navigate = (next: Route) => {
    window.location.hash = pageHref(next.section, next.path)
    setRouteState(next)
  }

  useEffect(() => {
    const onHashChange = () => setRouteState(routeFromHash())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  // Keep the URL canonical (legacy + bare hashes resolve to #/<section>/<page>).
  useEffect(() => {
    const canonical = pageHref(route.section, route.path)
    if (window.location.hash !== canonical) {
      window.history.replaceState(null, "", canonical)
    }
  }, [route.section, route.path])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setSearchOpen(true)
        document.querySelector<HTMLInputElement>(".docs-search-input")?.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div className="docs-page">
      <header className="docs-topbar">
        <a href="https://openscience.sh" className="docs-brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <span className="docs-brand-text">
            <small>OpenScience</small>
            <strong>Docs</strong>
          </span>
        </a>
        <div className="docs-search" role="search">
          <Search size={14} strokeWidth={1.8} />
          <input
            className="docs-search-input"
            aria-label="Search documentation"
            value={query}
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
            onChange={(event) => {
              setQuery(event.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search all docs..."
            type="search"
          />
          <kbd>⌘K</kbd>
          {searchOpen ? (
            <div className="docs-search-results" role="listbox" aria-label="documentation search results">
              {searchResults.length > 0 ? (
                searchResults.map((page) => (
                  <a
                    key={`${page.section}/${page.path}`}
                    href={pageHref(page.section, page.path)}
                    role="option"
                    aria-selected={section === page.section && route.path === page.path}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      navigate({ section: page.section, path: page.path })
                      setQuery("")
                      setSearchOpen(false)
                    }}
                  >
                    <span>{page.icon}</span>
                    <strong>{page.title}</strong>
                    <small>{page.sectionLabel}</small>
                  </a>
                ))
              ) : (
                <span className="docs-search-empty">No docs match that query.</span>
              )}
            </div>
          ) : null}
        </div>
        <nav className="docs-actions" aria-label="documentation actions">
          <button
            type="button"
            className="docs-theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "switch to light mode" : "switch to dark mode"}
            title={theme === "dark" ? "light mode" : "dark mode"}
          >
            {theme === "dark" ? <Sun size={14} strokeWidth={1.8} /> : <Moon size={14} strokeWidth={1.8} />}
            <span>{theme === "dark" ? "light" : "dark"}</span>
          </button>
          <a
            className="docs-topbar-cta"
            href={config.navbar?.primary?.href ?? "https://github.com/synthetic-sciences/openscience"}
          >
            {(config.navbar?.primary?.label ?? "Star on GitHub").toLowerCase()}
            <ArrowUpRight size={13} strokeWidth={1.8} />
          </a>
        </nav>
      </header>

      <div className="docs-shell">
        <aside className="docs-sidebar" aria-label="documentation navigation">
          <div className="docs-sidebar-title">
            <span>{sectionMeta.label}</span>
            <small>{sectionMeta.tagline}</small>
          </div>
          {navTabs.length > 1 ? (
            <nav className="docs-section-tabs" aria-label="documentation sections">
              {navTabs.map((tab) => {
                const firstPage = tab.groups
                  .flatMap((group) => flattenPages(group.pages))
                  .find((path) => docPages[path])
                return firstPage ? (
                  <a
                    key={tab.tab}
                    className={activeTab?.tab === tab.tab ? "active" : undefined}
                    href={pageHref(section, firstPage)}
                    onClick={() => navigate({ section, path: firstPage })}
                  >
                    {tab.tab}
                  </a>
                ) : null
              })}
            </nav>
          ) : null}
          {activeTab ? (
            <div key={activeTab.tab}>
              {activeTab.groups.map((group) => (
                <div key={group.group} className="docs-sidebar-group">
                  <span>{group.group}</span>
                  {flattenPages(group.pages).map((path) => {
                    const page = docPages[path]
                    if (!page) return null
                    return (
                      <a
                        key={path}
                        href={pageHref(section, path)}
                        className={route.path === path ? "active" : undefined}
                        onClick={() => navigate({ section, path })}
                      >
                        <span>{page.icon}</span>
                        {page.title}
                      </a>
                    )
                  })}
                </div>
              ))}
            </div>
          ) : null}
        </aside>

        <main className="docs-main">
          <nav className="docs-breadcrumbs" aria-label="breadcrumbs">
            <a href={pageHref(section, "index")}>{sectionMeta.label}</a>
            <ChevronRight size={13} strokeWidth={1.8} />
            {activeGroup ? <span>{activeGroup.group}</span> : null}
          </nav>
          <section className="docs-hero">
            <h1>{activePage.title}</h1>
            {activePage.description ? <p>{activePage.description}</p> : null}
          </section>

          <article className="docs-markdown">{renderMintlifyContent(activePage.body)}</article>

          <nav className="docs-pagination" aria-label="documentation pagination">
            {previousPage ? (
              <a
                href={pageHref(section, previousPage.path)}
                onClick={() => navigate({ section, path: previousPage.path })}
              >
                <ChevronLeft size={16} strokeWidth={1.8} />
                <span>
                  <small>Previous</small>
                  {previousPage.title}
                </span>
              </a>
            ) : (
              <span />
            )}
            {nextPage ? (
              <a href={pageHref(section, nextPage.path)} onClick={() => navigate({ section, path: nextPage.path })}>
                <span>
                  <small>Next</small>
                  {nextPage.title}
                </span>
                <ChevronRight size={16} strokeWidth={1.8} />
              </a>
            ) : (
              <span />
            )}
          </nav>
        </main>

        <aside className="docs-toc" aria-label="on this page">
          <span>On this page</span>
          {activePage.headings.length > 0 ? (
            activePage.headings.map((heading) => (
              <a
                key={heading}
                href={`#${heading
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-|-$/g, "")}`}
              >
                {heading}
              </a>
            ))
          ) : (
            <span className="docs-toc-empty">No sections</span>
          )}
          {(config.navigation.global?.anchors ?? []).length > 0 ? (
            <div className="docs-agent-links">
              <span>Agent resources</span>
              {(config.navigation.global?.anchors ?? []).map((anchor) => (
                <a
                  key={anchor.href}
                  href={anchor.href}
                  target={anchor.href.startsWith("http") ? "_blank" : undefined}
                  rel="noreferrer"
                >
                  {anchor.anchor}
                  <ArrowUpRight size={11} strokeWidth={1.8} />
                </a>
              ))}
            </div>
          ) : null}
        </aside>
      </div>

      <style>{docsCss}</style>
    </div>
  )
}

const docsCss = `
  .docs-page {
    --color-bg: #fafbfc;
    --color-bg-subtle: #f1f3f5;
    --color-bg-elevated: #ffffff;
    --color-border: rgba(15, 23, 42, 0.10);
    --color-text: #0f172a;
    --color-text-muted: #475569;
    --color-text-faint: #94a3b8;
    --docs-accent: #2f6f54;
    min-height: 100dvh;
    color: var(--color-text);
    background: var(--color-bg);
    font-family: ${DOCS_SERIF};
    font-feature-settings: "kern", "liga";
  }

  /* No italics anywhere - the font family ships regular and bold only. */
  .docs-page em,
  .docs-page i,
  .docs-page cite,
  .docs-page dfn,
  .docs-page address {
    font-style: normal;
  }

  .dark .docs-page {
    --color-bg: #0a0a0b;
    --color-bg-subtle: #141417;
    --color-bg-elevated: #1c1c20;
    --color-border: rgba(255, 255, 255, 0.10);
    --color-text: #f1f5f9;
    --color-text-muted: #b8bbc4;
    --color-text-faint: #6c7280;
    --docs-accent: #9bd6b4;
  }

  .docs-topbar {
    height: 60px;
    display: grid;
    grid-template-columns: minmax(200px, 1fr) minmax(240px, 520px) minmax(200px, 1fr);
    align-items: center;
    gap: 20px;
    padding: 0 28px;
    border-bottom: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-bg) 94%, transparent);
    backdrop-filter: blur(14px);
    position: sticky;
    top: 0;
    z-index: 30;
  }

  .docs-topbar nav,
  .docs-topbar nav a,
  .docs-search,
  .docs-copy,
  .docs-markdown a {
    display: flex;
    align-items: center;
  }

  .docs-brand {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    color: var(--color-text);
    text-decoration: none;
    min-width: 0;
    padding: 4px 6px;
    border-radius: 6px;
    transition: background 120ms ease;
  }

  .docs-brand:hover {
    background: var(--color-bg-elevated);
  }

  .docs-brand img {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
  }

  .docs-brand-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    line-height: 1.1;
  }

  .docs-brand-text small {
    font-family: ${mono};
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-text-faint);
  }

  .docs-brand-text strong {
    font-family: ${DOCS_SERIF};
    font-size: 15px;
    font-weight: 400;
    letter-spacing: 0;
    color: var(--color-text);
  }

  .docs-search {
    position: relative;
    height: 34px;
    gap: 9px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-elevated);
    padding: 0 8px 0 12px;
    color: var(--color-text-faint);
    transition: border-color 120ms ease, background 120ms ease;
  }

  .docs-search:focus-within {
    border-color: var(--color-text-faint);
    background: var(--color-bg);
  }

  .docs-search input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--color-text);
    font-family: ${DOCS_SERIF};
    font-size: 14px;
  }

  .docs-search input::placeholder {
    color: var(--color-text-faint);
    font-family: ${DOCS_SERIF};
  }

  .docs-search kbd {
    min-width: 32px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text-faint);
    font-family: ${mono};
    font-size: 10.5px;
    font-weight: 500;
    flex-shrink: 0;
  }

  .docs-search-results {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-elevated);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
    z-index: 50;
  }

  .docs-search-results a {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 1px 8px;
    align-items: center;
    padding: 8px;
    border-radius: 7px;
    color: var(--color-text);
    text-decoration: none;
  }

  .docs-search-results a:hover {
    background: var(--color-bg-subtle);
  }

  .docs-search-results a > span {
    grid-row: span 2;
    color: var(--color-text-faint);
  }

  .docs-search-results strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 700;
  }

  .docs-search-results small,
  .docs-search-empty {
    overflow: hidden;
    color: var(--color-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .docs-search-empty {
    padding: 10px;
  }

  .docs-topbar nav {
    gap: 8px;
    justify-content: flex-end;
  }

  .docs-actions {
    justify-content: flex-end;
    gap: 8px;
  }

  .docs-topbar nav a {
    gap: 6px;
    height: 34px;
    padding: 0 14px;
    border-radius: 6px;
    color: var(--color-text-muted);
    text-decoration: none;
    font-family: ${DOCS_SERIF};
    font-size: 14px;
    font-weight: 400;
    border: 1px solid transparent;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .docs-topbar nav a:hover {
    color: var(--color-text);
    background: var(--color-bg-elevated);
    border-color: var(--color-border);
  }

  .docs-topbar-cta {
    color: var(--color-text) !important;
    border-color: var(--color-border) !important;
    background: var(--color-bg-elevated);
  }

  .docs-theme-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--color-text-muted);
    font-family: ${DOCS_SERIF};
    font-size: 14px;
    font-weight: 400;
    line-height: 1;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .docs-theme-toggle:hover {
    color: var(--color-text);
    background: var(--color-bg-elevated);
    border-color: var(--color-border);
  }

  .docs-theme-toggle:focus-visible {
    outline: 2px solid var(--docs-accent);
    outline-offset: 2px;
  }

  .docs-shell {
    display: grid;
    grid-template-columns: 236px minmax(0, 760px) 176px;
    gap: 34px;
    max-width: 1240px;
    margin: 0 auto;
    padding: 30px 28px 84px;
  }

  .docs-sidebar,
  .docs-toc {
    position: sticky;
    top: 84px;
    align-self: start;
    max-height: calc(100dvh - 104px);
    overflow: auto;
  }

  .docs-sidebar {
    padding-right: 4px;
  }

  .docs-sidebar-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 0 14px 4px;
  }

  .docs-sidebar-title span {
    font-size: 13px;
    font-weight: 700;
  }

  .docs-sidebar-title small {
    color: var(--color-text-faint);
    font-family: ${mono};
    font-size: 11px;
  }

  .docs-section-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
    margin: 0 0 20px;
    padding: 3px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-subtle);
  }

  .docs-section-tabs a {
    display: flex;
    min-height: 28px;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    color: var(--color-text-muted);
    text-decoration: none;
    font-size: 12px;
  }

  .docs-section-tabs a.active {
    color: var(--color-text);
    background: var(--color-bg-elevated);
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.03);
  }

  .docs-sidebar-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 20px;
  }

  .docs-sidebar-group > span,
  .docs-toc > span,
  .docs-toc-empty,
  .docs-copy {
    font-family: ${mono};
    font-size: 11px;
    letter-spacing: 0;
  }

  .docs-sidebar-group > span,
  .docs-toc > span,
  .docs-toc-empty {
    color: var(--color-text-faint);
  }

  .docs-sidebar-group > span {
    margin: 0 0 7px 4px;
    text-transform: uppercase;
  }

  .docs-sidebar a,
  .docs-toc a {
    color: var(--color-text-muted);
    text-decoration: none;
    font-size: 13px;
    line-height: 1.45;
  }

  .docs-sidebar a {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 30px;
    padding: 0 6px;
    border-radius: 6px;
  }

  .docs-sidebar a span {
    color: var(--color-text-faint);
    line-height: 0;
  }

  .docs-sidebar a:hover {
    color: var(--color-text);
    background: var(--color-bg-subtle);
  }

  .docs-sidebar a.active {
    color: var(--color-text);
    background: color-mix(in srgb, var(--color-bg-subtle) 82%, var(--docs-accent) 8%);
    font-weight: 700;
  }

  .docs-sidebar a.active span {
    color: var(--color-text);
  }

  .docs-main {
    min-width: 0;
  }

  .docs-breadcrumbs {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 2px 0 16px;
    color: var(--color-text-faint);
    font-size: 13px;
  }

  .docs-breadcrumbs a {
    color: inherit;
    text-decoration: none;
  }

  .docs-breadcrumbs a:hover {
    color: var(--color-text);
  }

  .docs-hero {
    padding: 0 0 24px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 30px;
  }

  .docs-hero h1 {
    margin: 0;
    font-family: ${DOCS_SERIF};
    font-size: 40px;
    line-height: 1.08;
    font-weight: 700;
    letter-spacing: -0.005em;
    color: var(--color-text);
  }

  .docs-hero p {
    max-width: 680px;
    margin: 12px 0 0;
    font-family: ${DOCS_SERIF};
    color: var(--color-text-muted);
    font-size: 17px;
    line-height: 1.55;
  }

  .docs-markdown {
    color: var(--color-text);
    font-family: ${DOCS_SERIF};
  }

  .docs-markdown > *:first-child {
    margin-top: 0;
  }

  .docs-markdown p,
  .docs-markdown li,
  .docs-markdown td {
    color: var(--color-text-muted);
    font-family: ${DOCS_SERIF};
    font-size: 16px;
    line-height: 1.7;
    font-feature-settings: "kern", "liga", "onum";
  }

  .docs-markdown p {
    margin: 0 0 16px;
  }

  .docs-markdown h2 {
    margin: 36px 0 12px;
    padding-top: 6px;
    font-family: ${DOCS_SERIF};
    font-size: 24px;
    line-height: 1.2;
    font-weight: 700;
    letter-spacing: 0;
    color: var(--color-text);
    scroll-margin-top: 84px;
  }

  .docs-markdown h3 {
    margin: 26px 0 10px;
    font-family: ${DOCS_SERIF};
    font-size: 18px;
    line-height: 1.28;
    font-weight: 700;
    letter-spacing: 0;
    color: var(--color-text);
  }

  .docs-markdown strong {
    font-weight: 700;
    color: var(--color-text);
  }

  .docs-markdown em {
    font-style: normal;
    color: var(--color-text);
    font-weight: 700;
  }

  .docs-markdown ul,
  .docs-markdown ol {
    margin: 0 0 18px;
    padding-left: 20px;
  }

  .docs-markdown a {
    display: inline-flex;
    gap: 5px;
    color: var(--color-text);
    text-decoration: underline;
    text-decoration-color: var(--color-text-faint);
    text-underline-offset: 3px;
  }

  .docs-ghstars {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 2px 0 26px;
  }

  .docs-ghstars a {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 13px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-elevated);
    color: var(--color-text-muted);
    text-decoration: none;
    font-family: ${mono};
    font-size: 12px;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }

  .docs-ghstars a:hover {
    color: var(--color-text);
    border-color: color-mix(in srgb, var(--docs-accent) 44%, var(--color-border));
  }

  .docs-ghstars-primary {
    color: var(--color-text) !important;
    font-weight: 500;
  }

  .docs-ghstars-primary em {
    font-style: normal;
    font-weight: 700;
    padding-left: 8px;
    border-left: 1px solid var(--color-border);
    color: var(--docs-accent);
  }

  .docs-card-grid {
    display: grid;
    grid-template-columns: repeat(var(--docs-card-cols, 2), minmax(0, 1fr));
    gap: 10px;
    margin: 18px 0 26px;
  }

  .docs-card {
    position: relative;
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) 14px;
    gap: 10px;
    align-items: start !important;
    min-height: 96px;
    padding: 15px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-elevated);
    color: var(--color-text) !important;
    text-decoration: none !important;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.02);
  }

  .docs-card:hover {
    border-color: color-mix(in srgb, var(--docs-accent) 34%, var(--color-border));
    background: var(--color-bg-subtle);
  }

  .docs-card-horizontal {
    min-height: 78px;
  }

  .docs-card-icon {
    display: none;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text);
    background: var(--color-bg);
  }

  .docs-card-copy {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
  }

  .docs-card-copy strong {
    font-size: 13.5px;
    line-height: 1.25;
    font-weight: 700;
  }

  .docs-card-copy small {
    color: var(--color-text-muted);
    font-size: 12.75px;
    line-height: 1.55;
  }

  .docs-code-wrap {
    position: relative;
    margin: 16px 0 22px;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: #11150f;
  }

  .docs-code-wrap pre {
    margin: 0;
    padding: 18px 16px;
    overflow: auto;
    font-family: ${mono};
    font-size: 12px;
    line-height: 1.72;
    color: #eef4ee;
  }

  .docs-copy {
    position: absolute;
    top: 8px;
    right: 8px;
    gap: 6px;
    min-height: 25px;
    padding: 0 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(238, 244, 238, 0.78);
    cursor: pointer;
  }

  .docs-inline-code {
    font-family: ${mono};
    font-size: 12px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-subtle);
    border-radius: 5px;
    color: var(--color-text);
    padding: 1px 5px;
  }

  .docs-table-wrap {
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    margin: 16px 0 22px;
  }

  .docs-table-wrap table {
    width: 100%;
    border-collapse: collapse;
    min-width: 560px;
  }

  .docs-table-wrap th,
  .docs-table-wrap td {
    padding: 10px 13px;
    border-bottom: 1px solid var(--color-border);
    text-align: left;
    vertical-align: top;
  }

  .docs-table-wrap th {
    font-family: ${mono};
    font-size: 11px;
    color: var(--color-text-faint);
    background: var(--color-bg-subtle);
  }

  .docs-callout {
    margin: 18px 0;
    padding: 14px 16px;
    border: 1px solid rgba(164, 120, 48, 0.28);
    border-left: 3px solid rgba(164, 120, 48, 0.64);
    border-radius: 7px;
    background: color-mix(in srgb, var(--color-bg-subtle) 74%, rgba(164, 120, 48, 0.12));
  }

  .docs-callout p {
    margin: 0;
    color: var(--color-text);
  }

  .docs-callout .docs-markdown p {
    margin: 0;
  }

  .docs-step-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 18px 0 28px;
  }

  .docs-step {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 13px;
    padding: 15px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-elevated);
  }

  .docs-step > span {
    width: 27px;
    height: 27px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-subtle);
    color: var(--color-text);
    font-family: ${mono};
    font-size: 12px;
    font-weight: 700;
  }

  .docs-step h3 {
    margin: 2px 0 8px;
  }

  .docs-toc {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding-left: 4px;
  }

  .docs-toc > span {
    margin-bottom: 4px;
  }

  .docs-toc a {
    line-height: 1.45;
  }

  .docs-agent-links {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 20px;
    padding-top: 14px;
    border-top: 1px solid var(--color-border);
  }

  .docs-agent-links > span {
    font-family: ${mono};
    font-size: 11px;
    color: var(--color-text-faint);
  }

  .docs-agent-links a {
    display: inline-flex;
    gap: 5px;
    align-items: center;
  }

  .docs-pagination {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid var(--color-border);
  }

  .docs-pagination a {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 68px;
    padding: 13px 14px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text);
    text-decoration: none;
    background: var(--color-bg);
  }

  .docs-pagination a:hover {
    background: var(--color-bg-subtle);
  }

  .docs-pagination a:last-child {
    justify-content: flex-end;
    text-align: right;
  }

  .docs-pagination small {
    display: block;
    margin-bottom: 4px;
    color: var(--color-text-faint);
    font-family: ${mono};
    font-size: 11px;
  }

  @media (max-width: 1180px) {
    .docs-shell {
      grid-template-columns: 224px minmax(0, 1fr);
      gap: 30px;
    }
    .docs-toc {
      display: none;
    }
  }

  @media (max-width: 860px) {
    .docs-topbar {
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 0 16px;
    }

    .docs-search {
      grid-column: 1 / -1;
      order: 2;
      display: none;
    }

    .docs-topbar nav a:not(.docs-topbar-cta) {
      display: none;
    }

    .docs-shell {
      display: block;
      padding: 22px 16px 64px;
    }

    .docs-sidebar {
      position: static;
      border: 1px solid var(--color-border);
      border-radius: 10px;
      padding: 14px 12px;
      margin-bottom: 22px;
      max-height: none;
    }

    .docs-hero h1 {
      font-size: 34px;
    }

    .docs-pagination {
      grid-template-columns: 1fr;
    }

    .docs-card-grid {
      grid-template-columns: 1fr;
    }
  }
`
