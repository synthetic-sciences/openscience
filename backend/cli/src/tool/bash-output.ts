import type { FileSink } from "bun"

/**
 * Bounded capture for a shell command's combined output.
 *
 * The previous capture kept every byte in memory and re-ran secret redaction
 * over the whole history on each chunk, so a noisy command cost memory
 * proportional to its output and quadratic CPU before the 50 KiB / 2,000-line
 * truncation ever ran. This capture redacts each completed run of lines once,
 * keeps only the head preview the model receives, and streams everything else
 * to an owned output file that is opened the moment the preview overflows.
 *
 * Redaction boundaries: the patterns in OpenScience.redactSecrets never span a
 * newline except the PEM block, so text is redacted in whole lines and an
 * unterminated `-----BEGIN … PRIVATE KEY-----` is held back until its END
 * marker arrives. A registered secret that straddles two chunks therefore
 * still lands in one redaction pass. Both holds are capped so a command that
 * never prints a newline cannot grow the pending buffer without bound.
 */
export namespace BashOutput {
  /** Longest run kept unflushed while waiting for a newline or a PEM END. */
  export const HOLD_LIMIT = 64 * 1024
  const PEM_BEGIN = "-----BEGIN"
  const PEM_END = "-----END"

  export interface Options {
    redact: (text: string) => string
    maxBytes: number
    maxLines: number
    /** Opened once, when the preview first overflows. Receives every redacted
     * byte from the start of the output. */
    open: () => FileSink
    /** Called after the preview changed; callers throttle their own publishing. */
    onPreview?: (preview: string) => void
  }

  export interface Summary {
    /** Redacted head of the output, within the byte and line limits. */
    preview: string
    truncated: boolean
    bytes: number
    lines: number
    /** What the preview left out, in the unit whose limit was hit first. */
    removed: { count: number; unit: "bytes" | "lines" }
  }

  export class Capture {
    // Unflushed text is kept as separate parts and joined only when a flush is
    // due. A substring in JavaScriptCore keeps its base string alive, so
    // carrying `pending.slice(n)` from one concatenation to the next would
    // have chained every chunk ever received into memory.
    private parts: string[] = []
    private pendingLength = 0
    private preview = ""
    private previewBytes = 0
    private previewLines = 0
    private previewClosed = false
    private hitBytes = false
    private bytes = 0
    private lines = 0
    private sink: FileSink | undefined
    private ended = false

    constructor(private readonly options: Options) {}

    write(chunk: Buffer | string): void {
      if (this.ended) return
      const text = typeof chunk === "string" ? chunk : chunk.toString()
      if (!text) return
      this.parts.push(text)
      this.pendingLength += text.length
      if (text.includes("\n") || this.pendingLength > HOLD_LIMIT) this.flush(false)
    }

    /** Flush what is still pending, close the sink and describe the result. */
    async end(): Promise<Summary> {
      if (!this.ended) {
        this.ended = true
        this.flush(true)
        if (this.sink) await this.sink.end()
      }
      const removed = this.hitBytes
        ? { count: this.bytes - this.previewBytes, unit: "bytes" as const }
        : { count: this.lines - this.previewLines, unit: "lines" as const }
      return {
        preview: this.preview,
        truncated: this.previewClosed,
        bytes: this.bytes,
        lines: this.lines,
        removed,
      }
    }

    /** The preview as it stands, for live progress updates. */
    current(): string {
      return this.preview
    }

    private flush(final: boolean): void {
      const pending = this.parts.length === 1 ? this.parts[0] : this.parts.join("")
      const emit = (() => {
        if (final) return pending
        const newline = pending.lastIndexOf("\n")
        if (newline < 0) {
          // A single line past the hold limit is flushed anyway, at its last
          // whitespace when it has one: no secret pattern spans whitespace, so
          // the cut cannot split a token between two redaction passes.
          if (pending.length <= HOLD_LIMIT) return ""
          const space = pending.search(/\s\S*$/)
          return space > 0 ? pending.slice(0, space + 1) : pending
        }
        const complete = pending.slice(0, newline + 1)
        // Keep an open PEM block together so its body lines cannot escape the
        // multi-line pattern by arriving in a different pass.
        const begin = complete.lastIndexOf(PEM_BEGIN)
        if (begin >= 0 && !complete.includes(PEM_END, begin) && complete.length - begin <= HOLD_LIMIT) {
          return complete.slice(0, begin)
        }
        return complete
      })()
      if (!emit) return
      const rest = pending.slice(emit.length)
      this.parts = rest ? [rest] : []
      this.pendingLength = rest.length
      this.accept(this.options.redact(emit))
    }

    private accept(text: string): void {
      if (!text) return
      const size = Buffer.byteLength(text, "utf-8")
      const newlines = count(text, "\n")
      this.bytes += size
      this.lines += newlines
      if (this.sink) {
        this.sink.write(text)
        return
      }
      if (this.previewClosed) {
        this.sink = this.options.open()
        this.sink.write(this.preview)
        this.sink.write(text)
        return
      }
      const fits =
        this.previewBytes + size <= this.options.maxBytes && this.previewLines + newlines < this.options.maxLines
      if (fits) {
        this.preview += text
        this.previewBytes += size
        this.previewLines += newlines
        this.options.onPreview?.(this.preview)
        return
      }
      // First overflow: keep whole lines up to the limits, then hand the full
      // stream to the owned file from its first byte.
      const kept = this.head(text)
      this.preview += kept
      this.previewBytes += Buffer.byteLength(kept, "utf-8")
      this.previewLines += count(kept, "\n")
      this.previewClosed = true
      this.sink = this.options.open()
      this.sink.write(this.preview)
      this.sink.write(text.slice(kept.length))
      this.options.onPreview?.(this.preview)
    }

    /** The longest whole-line prefix of `text` that still fits the limits. */
    private head(text: string): string {
      const lineBudget = this.options.maxLines - this.previewLines
      const byteBudget = this.options.maxBytes - this.previewBytes
      let end = 0
      let bytes = 0
      let lines = 0
      while (end < text.length) {
        const next = text.indexOf("\n", end)
        const stop = next < 0 ? text.length : next + 1
        const size = Buffer.byteLength(text.slice(end, stop), "utf-8")
        if (bytes + size > byteBudget) {
          this.hitBytes = true
          break
        }
        if (next >= 0 && lines + 1 >= lineBudget) break
        bytes += size
        lines += next >= 0 ? 1 : 0
        end = stop
      }
      return text.slice(0, end)
    }
  }

  function count(text: string, needle: string): number {
    let total = 0
    let index = text.indexOf(needle)
    while (index >= 0) {
      total++
      index = text.indexOf(needle, index + needle.length)
    }
    return total
  }
}
