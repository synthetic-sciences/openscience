import z from "zod"
import { EOL } from "os"
import { NamedError } from "@synsci/util/error"
import { logo as glyphs } from "./logo"

/** Whether to emit ANSI escape sequences in CLI output.
 *
 *  Honors:
 *  - FORCE_COLOR=<truthy>      → always on (CI badges, test fixtures)
 *  - NO_COLOR set to anything  → always off (https://no-color.org/)
 *  - TERM=dumb                 → off (Emacs shell-mode, legacy)
 *  - default                   → on iff both stdout and stderr are TTYs
 *
 *  Without this gate, piping the CLI to a file or grep writes literal
 *  escape sequences ("\x1b[93m\x1b[1mAnthropic\x1b[0m") instead of plain
 *  text. Same problem in Docker logs, systemd journal, and TERM=dumb
 *  environments. */
function _detectColor(): boolean {
  const env = (typeof process !== "undefined" && process.env) || {}
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false") {
    return true
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false
  }
  if (env.TERM === "dumb") {
    return false
  }
  return Boolean(typeof process !== "undefined" && process.stdout?.isTTY && process.stderr?.isTTY)
}

const _COLOR = _detectColor()
const _ansi = (code: string) => (_COLOR ? code : "")

export namespace UI {
  export const CancelledError = NamedError.create("UICancelledError", z.void())

  /** Did color get enabled this run? Useful for callers that need to
   *  reason about ANSI emission (e.g. avoid double-counting widths). */
  export const colorsEnabled = _COLOR

  export const Style = {
    TEXT_HIGHLIGHT: _ansi("\x1b[93m"),
    TEXT_HIGHLIGHT_BOLD: _ansi("\x1b[93m\x1b[1m"),
    TEXT_DIM: _ansi("\x1b[90m"),
    TEXT_DIM_BOLD: _ansi("\x1b[90m\x1b[1m"),
    TEXT_NORMAL: _ansi("\x1b[0m"),
    TEXT_NORMAL_BOLD: _ansi("\x1b[1m"),
    TEXT_WARNING: _ansi("\x1b[93m"),
    TEXT_WARNING_BOLD: _ansi("\x1b[93m\x1b[1m"),
    TEXT_DANGER: _ansi("\x1b[91m"),
    TEXT_DANGER_BOLD: _ansi("\x1b[91m\x1b[1m"),
    TEXT_SUCCESS: _ansi("\x1b[92m"),
    TEXT_SUCCESS_BOLD: _ansi("\x1b[92m\x1b[1m"),
    TEXT_INFO: _ansi("\x1b[33m"),
    TEXT_INFO_BOLD: _ansi("\x1b[33m\x1b[1m"),
    TEXT_LOGO_CYAN: _ansi("\x1b[36m"),
  }

  export function println(...message: string[]) {
    print(...message)
    Bun.stderr.write(EOL)
  }

  export function print(...message: string[]) {
    blank = false
    Bun.stderr.write(message.join(" "))
  }

  let blank = false
  export function empty() {
    if (blank) return
    println("" + Style.TEXT_NORMAL)
    blank = true
  }

  export function logo(pad?: string) {
    const result: string[] = []
    const reset = Style.TEXT_NORMAL
    const cyan = Style.TEXT_LOGO_CYAN
    const dim = Style.TEXT_DIM
    const structural = new Set("╔═╗╚╝║╗╝╰╯─".split(""))

    for (const line of glyphs.lines) {
      if (pad) result.push(pad)
      // yargs' help formatter trims leading whitespace per line, which
      // destroys the glyph indentation (the O's top row shifts left and the
      // letters shear). Braille blank (U+2800) renders as a blank cell but
      // isn't whitespace, so the margin survives formatting.
      const lead = line.length - line.trimStart().length
      result.push("⠀".repeat(lead))
      for (const ch of line.slice(lead)) {
        if (structural.has(ch)) {
          result.push(dim, ch, reset)
        } else if (ch === " ") {
          result.push(ch)
        } else {
          result.push(cyan, ch, reset)
        }
      }
      result.push(EOL)
    }
    return result.join("").trimEnd()
  }

  export async function input(prompt: string): Promise<string> {
    const readline = require("readline")
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    return new Promise((resolve) => {
      rl.question(prompt, (answer: string) => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }

  export function error(message: string) {
    println(Style.TEXT_DANGER_BOLD + "Error: " + Style.TEXT_NORMAL + message)
  }

  export function markdown(text: string): string {
    return text
  }
}
