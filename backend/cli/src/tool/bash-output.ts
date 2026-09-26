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
 * Complete lines are redacted together. Open private-key blocks are held
 * until their END marker; oversized incomplete lines and key blocks are
 * discarded with an explicit redaction marker instead of exposing fragments.
 */
export namespace BashOutput {
  /** Longest run kept unflushed while waiting for a newline or a PEM END. */
  export const HOLD_LIMIT = 64 * 1024

  export interface Options {
    redact: (text: string) => string
    maxBytes: number
    maxLines: number
    /** Retain a redacted head only (for provenance), without opening a file. */
    previewOnly?: boolean
    /** Opened once, when the preview first overflows. Receives every redacted
     * byte from the start of the output. */
    open: () => FileSink
    /** Called after the preview changed; callers throttle their own publishing. */
    onPreview?: (preview: string) => void
    /** How much of the end of an overflowing output stays in memory for the
     * model: a traceback or a final status line sits at the tail, and a model
     * shown the head alone tends not to spend a step on the saved file. */
    tailBytes?: number
    tailLines?: number
  }

  export const TAIL_BYTES = 4 * 1024
  export const TAIL_LINES = 40

  export interface Summary {
    /** Redacted head of the output, within the byte and line limits. */
    preview: string
    truncated: boolean
    bytes: number
    lines: number
    /** What the preview left out, in the unit whose limit was hit first. */
    removed: { count: number; unit: "bytes" | "lines" }
    /** The last whole lines of an overflowing output, within the tail limits;
     * empty when nothing overflowed. */
    tail: string
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
    private dropping: "line" | "pem" | undefined
    private marker = ""
    // The tail after overflow, as a small list of parts trimmed from the
    // front, so a noisy command costs the tail budget and no more.
    private tailParts: string[] = []
    private tailLength = 0

    constructor(private readonly options: Options) {}

    write(chunk: Buffer | string): void {
      if (this.ended || (this.options.previewOnly && this.previewClosed)) return
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
        tail: this.previewClosed ? this.tail() : "",
      }
    }

    /** The retained tail as whole lines: the first line is dropped when the
     * front trim cut through it, so the model never sees a fragment. */
    private tail(): string {
      const text = this.tailParts.join("")
      const budgetBytes = this.options.tailBytes ?? TAIL_BYTES
      const budgetLines = this.options.tailLines ?? TAIL_LINES
      let start = 0
      if (Buffer.byteLength(text, "utf-8") > budgetBytes) {
        // Trim by bytes, then forward to the next whole line.
        let bytes = 0
        let index = text.length
        while (index > 0 && bytes < budgetBytes) {
          index--
          bytes += Buffer.byteLength(text[index], "utf-8")
        }
        const newline = text.indexOf("\n", index)
        start = newline < 0 ? text.length : newline + 1
      }
      // Then by lines: keep the last `budgetLines`, counting a final line
      // without its newline as a line.
      const kept = text.slice(start)
      const trailing = kept.endsWith("\n") ? 1 : 0
      const lines = count(kept, "\n") + (trailing ? 0 : 1)
      if (lines > budgetLines) {
        let seen = 0
        for (let index = text.length - 1; index >= start; index--) {
          if (text[index] !== "\n") continue
          seen++
          if (seen === budgetLines + trailing) {
            start = index + 1
            break
          }
        }
      }
      return text.slice(start)
    }

    private keepTail(text: string): void {
      this.tailParts.push(text)
      this.tailLength += text.length
      // Keep a little more than the budget so whole-line trimming has slack;
      // characters are an upper bound on bytes here, so this never under-keeps.
      const slack = (this.options.tailBytes ?? TAIL_BYTES) * 2
      while (this.tailParts.length > 1 && this.tailLength - this.tailParts[0].length >= slack) {
        this.tailLength -= this.tailParts[0].length
        this.tailParts.shift()
      }
    }

    /** The preview as it stands, for live progress updates. */
    current(): string {
      return this.preview
    }

    private flush(final: boolean): void {
      let pending = this.parts.length === 1 ? this.parts[0] : this.parts.join("")
      if (this.dropping) {
        const input = this.marker + pending
        const end = this.dropping === "line" ? /\n/.exec(input) : /-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/.exec(input)
        if (!end) {
          // Only the bounded marker tail is needed to recognize a split END.
          this.marker = this.dropping === "pem" ? input.slice(-128) : ""
          this.parts = []
          this.pendingLength = 0
          return
        }
        pending = input.slice(end.index + end[0].length)
        if (this.dropping === "line") pending = "\n" + pending
        this.dropping = undefined
        this.marker = ""
        this.parts = pending ? [pending] : []
        this.pendingLength = pending.length
      }
      const newline = pending.lastIndexOf("\n")
      let end = final ? pending.length : newline + 1
      const begin = [...pending.matchAll(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/g)].at(-1)
      if (begin && !/-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/.test(pending.slice(begin.index))) {
        if (pending.length - begin.index > HOLD_LIMIT || final) {
          this.accept(this.options.redact(pending.slice(0, begin.index)))
          this.accept("[REDACTED]")
          this.dropping = "pem"
          this.marker = pending.slice(-128)
          this.parts = []
          this.pendingLength = 0
          return
        }
        end = Math.min(end, begin.index)
      }
      if (!end && pending.length > HOLD_LIMIT) {
        // There is no safe arbitrary cut: quoted and registered secrets may
        // contain whitespace or straddle it. Omit this overlong logical line
        // rather than leak a fragment or retain unbounded raw output.
        this.accept("[REDACTED: oversized output line]")
        this.dropping = "line"
        this.parts = []
        this.pendingLength = 0
        return
      }
      if (!end) return
      const rest = pending.slice(end)
      this.parts = rest ? [rest] : []
      this.pendingLength = rest.length
      this.accept(this.options.redact(pending.slice(0, end)))
    }

    private accept(text: string): void {
      if (!text || (this.options.previewOnly && this.previewClosed)) return
      const size = Buffer.byteLength(text, "utf-8")
      const newlines = count(text, "\n")
      this.bytes += size
      this.lines += newlines
      if (this.sink) {
        this.sink.write(text)
        this.keepTail(text)
        return
      }
      if (this.previewClosed) {
        this.sink = this.options.open()
        this.sink.write(this.preview)
        this.sink.write(text)
        this.keepTail(text)
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
      if (!this.options.previewOnly) {
        this.sink = this.options.open()
        this.sink.write(this.preview)
        this.sink.write(text.slice(kept.length))
        this.keepTail(text.slice(kept.length))
      }
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
