import type { MarkedExtension, TokenizerAndRendererExtension } from "marked"
import type katex from "katex"

// Delimiters cannot nest. Stopping at a second opener also avoids repeatedly
// scanning the rest of a long, unfinished streamed response at every opener.
const inline = /^\\\(((?:\\(?![()])[\s\S]|[^\\])+?)\\\)/
const display = /^\\\[((?:\\(?![[\]])[\s\S]|[^\\])+?)\\\]/

/** Recognize TeX delimiters before Markdown turns them into escaped brackets.
 * This is a token extension, not a source rewrite: code, links, HTML attributes,
 * escaped delimiters and incomplete streaming input keep Markdown semantics. */
export function backslashMath(engine: Pick<typeof katex, "renderToString">): MarkedExtension {
  const render = (text: string, displayMode: boolean) =>
    engine.renderToString(text.trim(), { displayMode, throwOnError: false, trust: false })

  return {
    extensions: [
      {
        name: "texDisplay",
        level: "block",
        start: (src) => src.search(/^ {0,3}\\\[/m),
        tokenizer(src) {
          const match = /^ {0,3}/.exec(src)!
          const math = display.exec(src.slice(match[0].length))
          if (!math || !math[1].trim()) return
          const end = match[0].length + math[0].length
          const tail = /^[\t ]*(?:\n|$)/.exec(src.slice(end))
          if (!tail) return
          return { type: "texDisplay", raw: src.slice(0, end + tail[0].length), text: math[1] }
        },
        renderer: (token) => render(token.text, true) + "\n",
      },
      {
        name: "texInline",
        level: "inline",
        start: (src) => src.search(/\\[([]/),
        tokenizer(src) {
          if (this.lexer.state.inRawBlock) return
          const math = inline.exec(src) ?? display.exec(src)
          if (!math || !math[1].trim()) return
          return { type: "texInline", raw: math[0], text: math[1], display: src.startsWith("\\[") }
        },
        renderer: (token) => render(token.text, token.display),
      },
    ],
  }
}

/** Keep the existing dollar syntax, without interpreting raw HTML code or a
 * pair of ordinary prices ("$5 and $20") as an inline equation. */
export function guardedDollarMath(extension: MarkedExtension): MarkedExtension {
  return {
    ...extension,
    extensions: extension.extensions?.map((item) => {
      if (!("tokenizer" in item) || item.level !== "inline") return item
      const original = item.tokenizer
      return {
        ...item,
        tokenizer(src, tokens) {
          if (this.lexer.state.inRawBlock) return
          const token = original.call(this, src, tokens)
          if (!token) return token
          if (/^\$[+-]?(?:\d|\.\d)/.test(token.raw) && /^[+-]?(?:\d|\.\d)/.test(src.slice(token.raw.length))) return
          return token
        },
      } satisfies TokenizerAndRendererExtension
    }),
  }
}
