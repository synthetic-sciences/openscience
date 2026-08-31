import type { BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import type { ThemeRegistrationResolved } from "@pierre/diffs"
import { backslashMath, guardedDollarMath } from "./marked-math"

// Heavy render deps (katex ~150KB gzip, shiki grammar registry, the marked
// extensions) are loaded on FIRST USE, not at module load — so first paint (the
// launchpad renders no markdown/math/code) never pays for them. Each loader is
// memoized after its first await.
export function retryable<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined
  return () => {
    if (pending) return pending
    pending = load().catch((error) => {
      pending = undefined
      throw error
    })
    return pending
  }
}

// Load the KaTeX engine AND its stylesheet together on first math render, so the
// ~790-rule katex CSS stays out of the entry stylesheet (it's only needed once
// markdown with math actually renders — never at first paint).
const loadKatex = retryable(() =>
  Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([module]) => module.default),
)

type BundledLanguages = (typeof import("shiki"))["bundledLanguages"]
const loadLangs = retryable<BundledLanguages>(() => import("shiki").then((module) => module.bundledLanguages))

const OPENSCIENCE_THEME = {
  name: "OpenScience",
  colors: {
    "editor.background": "transparent",
    "editor.foreground": "var(--text-base)",
    "gitDecoration.addedResourceForeground": "var(--syntax-diff-add)",
    "gitDecoration.deletedResourceForeground": "var(--syntax-diff-delete)",
    // "gitDecoration.conflictingResourceForeground": "#ffca00",
    // "gitDecoration.modifiedResourceForeground": "#1a76d4",
    // "gitDecoration.untrackedResourceForeground": "#00cab1",
    // "gitDecoration.ignoredResourceForeground": "#84848A",
    // "terminal.titleForeground": "#adadb1",
    // "terminal.titleInactiveForeground": "#84848A",
    // "terminal.background": "#141415",
    // "terminal.foreground": "#adadb1",
    // "terminal.ansiBlack": "#141415",
    // "terminal.ansiRed": "#ff2e3f",
    // "terminal.ansiGreen": "#0dbe4e",
    // "terminal.ansiYellow": "#ffca00",
    // "terminal.ansiBlue": "#008cff",
    // "terminal.ansiMagenta": "#c635e4",
    // "terminal.ansiCyan": "#08c0ef",
    // "terminal.ansiWhite": "#c6c6c8",
    // "terminal.ansiBrightBlack": "#141415",
    // "terminal.ansiBrightRed": "#ff2e3f",
    // "terminal.ansiBrightGreen": "#0dbe4e",
    // "terminal.ansiBrightYellow": "#ffca00",
    // "terminal.ansiBrightBlue": "#008cff",
    // "terminal.ansiBrightMagenta": "#c635e4",
    // "terminal.ansiBrightCyan": "#08c0ef",
    // "terminal.ansiBrightWhite": "#c6c6c8",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: {
        foreground: "var(--syntax-comment)",
      },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: {
        foreground: "var(--syntax-property)", // maybe attribute
      },
    },
    {
      scope: ["constant", "entity.name.constant", "variable.other.constant", "variable.language", "entity"],
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: ["entity.name", "meta.export.default", "meta.definition.variable"],
      settings: {
        foreground: "var(--syntax-type)",
      },
    },
    {
      scope: ["meta.object.member"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: [
        "variable.parameter.function",
        "meta.jsx.children",
        "meta.block",
        "meta.tag.attributes",
        "entity.name.constant",
        "meta.embedded.expression",
        "meta.template.expression",
        "string.other.begin.yaml",
        "string.other.end.yaml",
      ],
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["entity.name.function", "support.type.primitive"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: ["support.class.component"],
      settings: {
        foreground: "var(--syntax-type)",
      },
    },
    {
      scope: "keyword",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: [
        "keyword.operator",
        "storage.type.function.arrow",
        "punctuation.separator.key-value.css",
        "entity.name.tag.yaml",
        "punctuation.separator.key-value.mapping.yaml",
      ],
      settings: {
        foreground: "var(--syntax-operator)",
      },
    },
    {
      scope: ["storage", "storage.type"],
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: [
        "string",
        "punctuation.definition.string",
        "string punctuation.section.embedded source",
        "entity.name.tag",
      ],
      settings: {
        foreground: "var(--syntax-string)",
      },
    },
    {
      scope: "support",
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: ["support.type.object.module", "variable.other.object", "support.type.property-name.css"],
      settings: {
        foreground: "var(--syntax-object)",
      },
    },
    {
      scope: "meta.property-name",
      settings: {
        foreground: "var(--syntax-property)",
      },
    },
    {
      scope: "variable",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "variable.other",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: [
        "invalid.broken",
        "invalid.illegal",
        "invalid.unimplemented",
        "invalid.deprecated",
        "message.error",
        "markup.deleted",
        "meta.diff.header.from-file",
        "punctuation.definition.deleted",
        "brackethighlighter.unmatched",
        "token.error-token",
      ],
      settings: {
        foreground: "var(--syntax-critical)",
      },
    },
    {
      scope: "carriage-return",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: "string source",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "string variable",
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: [
        "source.regexp",
        "string.regexp",
        "string.regexp.character-class",
        "string.regexp constant.character.escape",
        "string.regexp source.ruby.embedded",
        "string.regexp string.regexp.arbitrary-repitition",
        "string.regexp constant.character.escape",
      ],
      settings: {
        foreground: "var(--syntax-regexp)",
      },
    },
    {
      scope: "support.constant",
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: "support.variable",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "meta.module-reference",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "punctuation.definition.list.begin.markdown",
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "markup.quote",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "markup.italic",
      settings: {
        fontStyle: "italic",
        // foreground: "",
      },
    },
    {
      scope: "markup.bold",
      settings: {
        fontStyle: "bold",
        foreground: "var(--text-strong)",
      },
    },
    {
      scope: [
        "markup.raw",
        "markup.inserted",
        "meta.diff.header.to-file",
        "punctuation.definition.inserted",
        "markup.changed",
        "punctuation.definition.changed",
        "markup.ignored",
        "markup.untracked",
      ],
      settings: {
        foreground: "var(--text-base)",
      },
    },
    {
      scope: "meta.diff.range",
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.diff.header",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.separator",
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.output",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.export.default",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: [
        "brackethighlighter.tag",
        "brackethighlighter.curly",
        "brackethighlighter.round",
        "brackethighlighter.square",
        "brackethighlighter.angle",
        "brackethighlighter.quote",
      ],
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: ["constant.other.reference.link", "string.other.link"],
      settings: {
        fontStyle: "underline",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "token.info-token",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "token.warn-token",
      settings: {
        foreground: "var(--syntax-warning)",
      },
    },
    {
      scope: "token.debug-token",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
  ],
  semanticTokenColors: {
    comment: "var(--syntax-comment)",
    string: "var(--syntax-string)",
    number: "var(--syntax-constant)",
    regexp: "var(--syntax-regexp)",
    keyword: "var(--syntax-keyword)",
    variable: "var(--syntax-variable)",
    parameter: "var(--syntax-variable)",
    property: "var(--syntax-property)",
    function: "var(--syntax-primitive)",
    method: "var(--syntax-primitive)",
    type: "var(--syntax-type)",
    class: "var(--syntax-type)",
    namespace: "var(--syntax-type)",
    enumMember: "var(--syntax-primitive)",
    "variable.constant": "var(--syntax-constant)",
    "variable.defaultLibrary": "var(--syntax-unknown)",
  },
} as unknown as ThemeRegistrationResolved

type DiffsModule = typeof import("@pierre/diffs")
const diffThemeRegistrars = new WeakSet<DiffsModule["registerCustomTheme"]>()

export function registerOpenScienceDiffTheme(diffs: Pick<DiffsModule, "registerCustomTheme">) {
  if (diffThemeRegistrars.has(diffs.registerCustomTheme)) return
  diffThemeRegistrars.add(diffs.registerCustomTheme)
  diffs.registerCustomTheme("OpenScience", () => Promise.resolve(OPENSCIENCE_THEME))
}

const loadDiffs = retryable(() =>
  import("@pierre/diffs").then((diffs) => {
    registerOpenScienceDiffTheme(diffs)
    return diffs
  }),
)

async function highlightCodeBlocks(html: string): Promise<string> {
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  if (matches.length === 0) return html

  const [diffs, bundledLanguages] = await Promise.all([loadDiffs(), loadLangs()])
  const highlighter = await diffs.getSharedHighlighter({ themes: ["OpenScience"], langs: [] })

  let result = html
  for (const match of matches) {
    const [fullMatch, lang, escapedCode] = match
    const code = decodeCodeBlockEntities(escapedCode)

    let language = lang || "text"
    if (!(language in bundledLanguages)) {
      language = "text"
    }
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(language as BundledLanguage)
    }

    const highlighted = highlighter.codeToHtml(code, {
      lang: language,
      theme: "OpenScience",
      tabindex: false,
    })
    result = result.replace(fullMatch, () => highlighted)
  }

  return result
}

const codeBlockEntities = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
} as const

/** Decode exactly one HTML-entity layer from Marked's escaped code. A single
 * replacement pass keeps input such as `&amp;lt;` literal instead of turning it
 * into `<` through a second, unsafe decode. */
export function decodeCodeBlockEntities(input: string) {
  return input.replace(
    /&(lt|gt|amp|quot|#39);/g,
    (entity) => codeBlockEntities[entity as keyof typeof codeBlockEntities],
  )
}

/**
 * Highlight a short snippet with the shared highlighter and the registered
 * OpenScience theme. `structure: "inline"` omits the <pre><code> wrapper so the
 * caller controls the container -- a thumbnail sizes and masks its own.
 */
export async function highlightSnippet(code: string, lang: string): Promise<string> {
  const [diffs, bundled] = await Promise.all([loadDiffs(), loadLangs()])
  const highlighter = await diffs.getSharedHighlighter({ themes: ["OpenScience"], langs: [] })
  const language = lang in bundled ? lang : "text"
  if (!highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(language as BundledLanguage)
  }
  return highlighter.codeToHtml(code, { lang: language, theme: "OpenScience", tabindex: false, structure: "inline" })
}

export type NativeMarkdownParser = (markdown: string) => Promise<string>

// The pure-JS marked pipeline (katex + shiki extensions) — built lazily on first
// use so its deps stay out of the entry chunk. Electron and web use this path;
// hosts with an optional native parser also use it for math-bearing Markdown.
const loadJsParser = retryable(async () => {
  const [{ Marked }, { default: markedKatex }, { default: markedShiki }, { default: katex }, bundledLanguages] =
    await Promise.all([
      import("marked"),
      import("marked-katex-extension"),
      import("marked-shiki"),
      import("katex"),
      loadLangs(),
    ])
  return new Marked(
    {
      renderer: {
        link({ href, title, text }) {
          const titleAttr = title ? ` title="${title}"` : ""
          return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
        },
      },
    },
    guardedDollarMath(markedKatex({ throwOnError: false, nonStandard: true, trust: false })),
    backslashMath(katex),
    markedShiki({
      async highlight(code, lang) {
        const diffs = await loadDiffs()
        const highlighter = await diffs.getSharedHighlighter({ themes: ["OpenScience"], langs: [] })
        if (!(lang in bundledLanguages)) {
          lang = "text"
        }
        if (!highlighter.getLoadedLanguages().includes(lang)) {
          await highlighter.loadLanguage(lang as BundledLanguage)
        }
        return highlighter.codeToHtml(code, { lang: lang || "text", theme: "OpenScience", tabindex: false })
      },
    }),
  )
})

export async function parseMarkdown(markdown: string, nativeParser?: NativeMarkdownParser): Promise<string> {
  // Native parsers may consume TeX backslashes as Markdown escapes. Parse math
  // from the original source; never substitute equations into arbitrary HTML.
  if (nativeParser && !/\$|\\[([]/.test(markdown)) return highlightCodeBlocks(await nativeParser(markdown))
  const parser = await loadJsParser()
  const html = await parser.parse(markdown)
  if (html.includes('class="katex')) await loadKatex()
  return html
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser }) => ({
    parse: (markdown: string) => parseMarkdown(markdown, props.nativeParser),
  }),
})
