import path from "path"
import fs from "node:fs/promises"
import type { Hooks, Plugin } from "@synsci/plugin"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { Filesystem } from "@/util/filesystem"
import { HarnessState } from "./state"

/**
 * When the request names its outputs, hold the model to them: detect the
 * specification on the first message, and before the turn ends check every
 * named file mechanically (present, non-empty, parses, no placeholders, no
 * NaN/Inf, no duplicate ids). One message lists the failures; two rounds at
 * most, then the model's answer stands.
 */
export namespace Deliverables {
  const EXTENSIONS =
    "csv|tsv|json|jsonl|md|txt|dat|png|jpg|jpeg|svg|pdf|parquet|npy|npz|mtx|yaml|yml|toml|py|r|ipynb|js|cpp|cc|lean|v|xlsx|html|tex|bib|fasta|pdb|cif|sdf|vcf|bam|bed|xyz|nii|onnx|pt|pth|ckpt|h5|hdf5|nc|tif|tiff|zip|tar|gz"
  // Paths are usually absolute in a task that names its outputs (`/app/out.csv`),
  // so the leading slash is part of the path rather than a reason to skip it.
  // A URL is excluded below by its scheme, not by the punctuation before it.
  // The lookbehind also refuses an ellipsis and a slash, so "…/sealed/x.csv"
  // is read neither as "/sealed/x.csv" nor as "sealed/x.csv". A backslash
  // before a candidate means it is the tail of a Windows or UNC path the
  // request spelled out in full; reporting the bare file name made the
  // checklist demand `fit.csv` in the project root instead.
  const PATH = new RegExp(`(?<![\\w@.\\-…/\\\\])(/?(?:[\\w.-]+/)*[\\w.-]+\\.(?:${EXTENSIONS}))(?![\\w/])`, "gi")
  // The span between the verb and its preposition routinely contains the file
  // name, so it cannot exclude dots: "Write /app/out.json as a JSON object".
  const INTENT =
    /\b(?:write|save|store|export|output|produce|create|emit|dump)\b[^\n]{0,80}?\b(?:to|as|in|at|into|named|called)\b/i
  const SHAPE = /\b(?:columns?|schema|keys?|fields?|header|format|rounded|decimal|units?|sorted by|one row per)\b/i
  const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|placeholder|dummy|lorem ipsum|xxx+|fill me|to be filled|<insert)\b/i
  const NEGATED =
    /\b(?:skip|don'?t|do not|not|later|except|ignore|without|omit|leave|instead of|rather than|no need)\b/i
  // A file the request tells the model to consult is an input, not something
  // it owes: "Read CONTRACTS.md and study.json first" names no deliverable.
  // The nearest verb before a path decides; "read config.yaml, then write
  // results/out.csv" keeps only the output.
  // "Submit it with `client.py`" names the instrument, not the deliverable,
  // and "the bound published in `spec.json`" refers to a file the model
  // reads: instrument and reference markers count as input verbs.
  const INPUT =
    /\b(?:read|inspect|consult|open|load|follow|see|check|review|use|given|based on|according to|(?:is|are|lives?|resides?|sits?|can be found)\s+(?:in|at|under|inside)|(?:published|described|defined|specified|listed|documented|provided|contained|found|available|supplied|shown)\s+(?:in|at|under)|(?:with|using|via|through)(?=\s+[`"']?\/?(?:[\w.-]+\/)*[\w.-]+\.\w))\b/gi
  // "Submit it as X", "Repair X", "a CSV saved at X" and "the graded
  // artifacts are X and Y" owe X as surely as "write X" does. A participle
  // counts only with a preposition toward the path: "packets generated from
  // the model" describes inputs.
  const PRODUCES =
    /\b(?:write|save|store|export|output|produce|create|emit|dump|generate|deliver|submit|edit|modify|repair|fix|place|put|(?:written|saved|stored|exported|placed|submitted|delivered|dumped|emitted)\s+(?:to|in|at|as|under|into)|(?:artifacts?|deliverables?|outputs?|submissions?)\s+(?:is|are))\b/gi
  /** A code deliverable is usually named before the verb that governs it:
   * "`solver.py`, which is the file you must edit", "Only `x.py` may be
   * modified". A short window after the path catches those. */
  const EDITED = /\b(?:edit|modif(?:y|ied)|updat(?:e|ed)|fill(?:ed)? in|implement(?:ed)?|complet(?:e|ed)|replace)\b/i
  const EDIT_WINDOW = 80
  /** Documentation placeholders, not paths the run owes; and an abbreviated
   * path (".../inputs/labels.csv", "…/out.csv") names a place the writer
   * elided, not a file anyone can check. */
  /** A directory named beside a bare file name: "save it inside `/results/`",
   * "under `out/`". Only a directory with a trailing slash, so a file path
   * with an extension is never mistaken for one. */
  const DIRECTORY =
    /\b(?:inside|in|into|under|within|to|at)\s+[`"']?((?:\/|~\/|\.\/)?(?:[\w.-]+\/)+)[`"']?(?=[\s.,;:)]|$)/i
  const PLACEHOLDER_PATH =
    /^(?:\/|\.{1,2}\/)?(?:path|absolute|your|some|a)\/|\/path\/to\/|^<|[<{]|(?:^|\/)(?:\.{3,}|…)(?:\/|$)/i
  // Task statements are usually sectioned rather than sentenced: a heading or
  // lead-in ("You are given:", "Create:") governs the bullet list under it, and
  // the bullets carry no verb of their own.
  const INPUT_SECTION =
    /\b(?:you are given|you are provided|inputs?\b|input (?:data|files?)|provided (?:files?|data|inputs?)|available (?:files?|data)|the following (?:files? )?(?:are|is) (?:provided|available|given)|data (?:files?|directory)|read the following)\b/i
  // "Provide:" opens a list of outputs; "the following files provide more
  // information" introduces inputs, so the verb counts only as an imperative.
  const OUTPUT_SECTION =
    /\b(?:create|write|produce|output|deliverables?|your (?:task|goal|job) is to (?:create|write|produce|output|generate)|save|submit|generate|report|record|store|required outputs?|expected outputs?|you must (?:create|write|produce|output|generate))\b|^\s*(?:[-*]\s+)?(?:\*\*)?provide\b/i
  /** A markdown heading that names neither inputs nor outputs ends the section
   * a previous heading opened, so "You are given:" does not govern the rest of
   * the document. */
  const HEADING = /^\s{0,3}#{1,6}\s/
  /** A lead-in ends in a colon ("Create the following files:") or is a bare
   * label on its own line ("**Required outputs**"); a sentence is neither. */
  const LEAD_IN = /:\s*(?:\*\*|__)?\s*$|^\s*(?:[-*]\s+)?(?:\*\*|__)?[A-Za-z][\w /&()-]{0,40}(?:\*\*|__)?\s*$/
  /** A sentence that announces a list without ending in a colon: "Write the
   * following six deliverables under /root/results. A missing file fails." */
  const LIST_INTRO =
    /\bthe following\b|\b(?:these|those|exactly)\b[^.:\n]{0,40}?\b(?:files?|outputs?|artifacts?|deliverables?|results?)\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:\w+\s+){0,3}(?:files?|outputs?|artifacts?|deliverables?)\b/i
  const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
  /** "it must write `a.json` and `b.csv` to `OUTPUT_DIR`": a destination
   * spelled as an all-caps placeholder is a program's contract for the files
   * it writes when the grader runs it, not files this turn owes; checked at
   * the workspace root they were "missing" every time. */
  const RUNTIME_DESTINATION =
    /\b(?:to|in|into|under|inside|within|at)\s+[`"']?(?:\$\{?)?[A-Z][A-Z0-9_]{3,}\}?\/?[`"']?(?=[\s.,;:)]|$)/
  /** "`spins_k.txt` — that is, `spins_0.txt` through `spins_5.txt`": a range
   * of numbered names, and the template it instantiates. */
  const RANGE = /\b(?:through|thru|to|up to)\b|\.{2,3}|…/i
  /** A sentence that names where a list of outputs goes without naming a
   * file: "Save final graded-set results to `/root/results/`.", "Create
   * `/root/results` with these required artifacts:". The bare names listed
   * under it live in that directory; checked at the workspace root they
   * were "missing", and one lead duplicated its finished files there. */
  const DESTINATION =
    /\b(?:save|write|store|place|put|create|produce|output|deliver|generate|results?)\b[^\n`]{0,80}?[`"']?((?:\/|~\/|\.\/)(?:[\w.-]+\/)*[\w-]+\/?)[`"']?(?=[\s.,;:)]|$)/i
  const PATH_LED = new RegExp(`^\\s*[\`*_"']*/?(?:[\\w.-]+/)*[\\w.-]+\\.(?:${EXTENSIONS})(?![\\w/])`, "i")
  const HAS_PATH = new RegExp(PATH.source, "i")
  /** What separates two paths declared together: "`a.R` and `b.R`", "x.csv, y.csv". */
  const CONJUNCTION = /^[\s,`'"*]*(?:and|or|\/)?[\s,`'"*]*$/i
  const NAN = /(?:^|[,\t;\s])(?:nan|NaN|NAN|inf|-inf|Inf|-Inf|Infinity|-Infinity|#N\/A)(?=$|[,\t;\s])/
  const MAX_BYTES = 64 * 1024 * 1024

  /** Lines outside fenced code. A fence opens with three or more backticks
   * or tildes and closes only with at least as many of the same character
   * (CommonMark), so an example that nests a ```python block inside a
   * ````md block stays one block; toggling on every ``` line inverted the
   * state at the inner fence and read the example's code as prose. */
  function unfenced(text: string) {
    const out: string[] = []
    let fence: { char: string; length: number } | undefined
    for (const line of text.split("\n")) {
      const mark = line.match(/^\s{0,3}(`{3,}|~{3,})/)
      if (fence) {
        if (mark && mark[1][0] === fence.char && mark[1].length >= fence.length && !line.slice(mark[0].length).trim())
          fence = undefined
        continue
      }
      if (mark) {
        fence = { char: mark[1][0], length: mark[1].length }
        continue
      }
      out.push(line)
    }
    return out
  }

  /** Paths whose nearest preceding verb says the model reads them. */
  function consulted(sentence: string) {
    const verbs = [
      ...[...sentence.matchAll(INPUT)].map((match) => ({ index: match.index, input: true })),
      ...[...sentence.matchAll(PRODUCES)].map((match) => ({ index: match.index, input: false })),
    ].sort((left, right) => left.index - right.index)
    return [...sentence.matchAll(PATH)]
      .filter((match) => verbs.filter((verb) => verb.index < match.index).at(-1)?.input === true)
      .map((match) => match[1])
  }

  /** Paths under a heading or lead-in that introduces the task's inputs or
   * its outputs, up to the next heading that changes the subject. A bullet
   * under "You are given:" is an input and one under "Required outputs" is
   * owed, even though neither bullet carries a verb of its own; a task that
   * specifies many artifacts lists them this way ("- Path: `outputs/x.csv`")
   * rather than writing a sentence about each. */
  function sectioned(text: string) {
    const inputs = new Set<string>()
    const outputs = new Set<string>()
    /** A bare item name and the path it resolves to under the list's
     * destination directory. */
    const placed = new Map<string, string>()
    let directory: string | undefined
    // Any line that talks about outputs ends an input list, which is a crude
    // but measured signal in heading-less prose. An owed list is opened only
    // by a heading ("## Required outputs", lasting to the next heading) or by
    // a lead-in that announces files without naming one ("Create these three
    // files:", "Write the following six deliverables under /root/results."),
    // lasting until a heading, a lead-in about something else, or a return
    // to the inputs. Explanatory paragraphs and code blocks between the items
    // keep the list open; a sentence that says "write" or "report" in passing
    // never opens one, and "Write `x.json` with this structure:" introduces
    // that file's layout, which the sentence rule already owes.
    let mode: "input" | "output" | undefined
    let owed: "heading" | "lead-in" | undefined
    // The level of the heading that opened the current section: a deeper
    // heading is a part of it ("## Required Outputs" then "### 1. The trace
    // (`/app/trace.md`)"), one at the same or a higher level ends it.
    let level = 0
    for (const line of unfenced(text)) {
      // Paths inside code are usage examples, not declarations.
      if (!line.trim()) continue
      const heading = HEADING.test(line)
      const item = LIST_ITEM.test(line) || PATH_LED.test(line) || /^\s/.test(line)
      // Words inside code spans are file names and flags (`report.md`,
      // `--input-dir`), not the sentence's subject.
      const prose = line.replace(/`[^`]*`/g, " ")
      const output = OUTPUT_SECTION.test(prose)
      const input = INPUT_SECTION.test(prose)
      const sentences = prose.split(/(?<=[.!?])\s+/).filter(Boolean)
      // "Produce X and Y. The public contracts are:" — the whole line says
      // the inputs are over, but only its last sentence governs the list.
      const last = sentences.at(-1) ?? prose
      const intro = LEAD_IN.test(line) ? last : sentences.find((sentence) => LIST_INTRO.test(sentence))
      const leads =
        intro !== undefined && !HAS_PATH.test(line) && OUTPUT_SECTION.test(intro) && !INPUT_SECTION.test(intro)
      // "Save the results to `/root/results/`." followed by a list: the
      // sentence opens the list and says where its items live.
      const destination = !heading && !item && output && !input && !HAS_PATH.test(line) ? line.match(DESTINATION) : null
      if (heading) {
        const depth = line.match(/^\s{0,3}(#{1,6})\s/)![1].length
        const names = output && !input ? "output" : input && !output ? "input" : undefined
        if (mode && !names && depth > level) {
          // A sub-heading inside a section stays in it. Under an outputs
          // heading, a sub-heading that names a file declares it: the file
          // is the subject of the sub-section, not a mention in a sentence.
          if (owed === "heading") for (const match of line.matchAll(PATH)) outputs.add(match[1])
          continue
        }
        mode = names
        owed = mode === "output" ? "heading" : undefined
        directory = undefined
        level = mode ? depth : 0
        continue
      }
      // Under an outputs heading nothing but the next heading changes the
      // subject; a lead-in's list is ended by a paragraph about the inputs or
      // a lead-in about something else, not by a mention inside an item.
      if (owed === "heading") {
      } else if (leads || destination) {
        mode = "output"
        owed = "lead-in"
        directory = destination ? destination[1].replace(/\/?$/, "/") : undefined
      } else if (output && !input) {
        // A paragraph under an inputs heading that happens to say "report"
        // or "record" describes the data; only a heading or a lead-in that
        // opens an owed list ends the inputs.
        if (!(mode === "input" && level)) mode = "output"
      } else if (input && !output && !(owed && item)) {
        mode = "input"
        owed = undefined
      } else if (owed && !item && intro !== undefined) {
        owed = undefined
        directory = undefined
      }
      if (mode === "input") {
        // A line naming both ("read X, then create Y") is governed per path
        // by the sentence rule, not by the section.
        if (output) continue
        for (const match of line.matchAll(PATH)) inputs.add(match[1])
        continue
      }
      // An owed path is declared, not mentioned: an item declares the path
      // it leads with, plus any joined to it ("`a.R` and `b.R`"); a path in
      // the item's description ("one row per line of `inputs.csv`") is left
      // to the sentence rule, since a false debt costs the model a round of
      // explaining.
      if (!owed || !(LIST_ITEM.test(line) || PATH_LED.test(line))) continue
      let end = -1
      for (const match of line.matchAll(PATH)) {
        if (end < 0 && INPUT_SECTION.test(line.slice(0, match.index).replace(/`[^`]*`/g, " "))) break
        if (end >= 0 && !CONJUNCTION.test(line.slice(end, match.index))) break
        const value = directory && !match[1].includes("/") ? `${directory}${match[1]}` : match[1]
        if (value !== match[1]) placed.set(match[1], value)
        outputs.add(value)
        end = match.index + match[0].length
      }
    }
    return { inputs, outputs, placed }
  }

  /** File paths a request names as outputs, in order of appearance, when it
   * reads like an output specification at all. */
  /** How far before a path a negation still governs it. "Skip results.csv"
   * waives; "write results.csv without the header" does not, because the
   * negation follows the path. */
  const NEGATION_WINDOW = 70

  /** "`/root/artifacts/spins_k.txt` — that is, `spins_0.txt` through
   * `spins_5.txt`": two names in one sentence that differ only in an integer
   * and are joined by a range word name every integer between them; a name
   * with the same shape whose varying part is not a number is the template
   * they instantiate, and the directory it carries is theirs. At most 64
   * names, since the list is checked file by file. */
  function expandRange(sentence: string, matches: RegExpMatchArray[]) {
    const shape = (name: string) => {
      const base = name.slice(name.lastIndexOf("/") + 1)
      const m = base.match(/^(.*?)(\d+|[a-z])(\.[^.]+)$/i)
      return m
        ? { prefix: m[1], part: m[2], suffix: m[3], directory: name.slice(0, name.lastIndexOf("/") + 1) }
        : undefined
    }
    for (let i = 0; i + 1 < matches.length; i++) {
      const left = shape(matches[i][1])
      const right = shape(matches[i + 1][1])
      if (!left || !right || left.prefix !== right.prefix || left.suffix !== right.suffix) continue
      if (!/^\d+$/.test(left.part) || !/^\d+$/.test(right.part)) continue
      const between = sentence.slice(matches[i].index! + matches[i][0].length, matches[i + 1].index)
      if (!RANGE.test(between) || /[.!?;]\s/.test(between)) continue
      const from = Number(left.part)
      const to = Number(right.part)
      if (to <= from || to - from >= 64) continue
      const template = matches
        .map((match) => match[1])
        .find((name) => {
          const other = shape(name)
          return other && other.prefix === left.prefix && other.suffix === left.suffix && !/^\d+$/.test(other.part)
        })
      const directory = template ? shape(template)!.directory : left.directory || right.directory
      const width = left.part.length === right.part.length ? left.part.length : 1
      const names = Array.from(
        { length: to - from + 1 },
        (_, k) => `${left.prefix}${String(from + k).padStart(width, "0")}${left.suffix}`,
      )
      return { endpoints: new Set([matches[i][1], matches[i + 1][1]]), names, template, directory }
    }
  }

  export function detect(text: string): string[] {
    const sections = sectioned(text)
    const produced: string[] = []
    const neutral: string[] = []
    // A waiver anywhere wins, whichever sentence made the request: "write
    // notes.md ... skip notes.md for now" leaves one deliverable, not two.
    const waived = new Set<string>()
    let intent = false
    // Fenced code shows usage and layouts; the prose names what is owed.
    const prose = unfenced(text).join("\n")
    for (const paragraph of prose.split(/\n\s*\n+/)) {
      // A paragraph that sends files to a placeholder directory describes
      // what a program writes when the grader runs it; its bare names are
      // that program's outputs, not this turn's. A full path in it is
      // explicit and stands. Read over the paragraph because the wrapped
      // line that names the destination is rarely the line naming the files.
      const runtime = RUNTIME_DESTINATION.test(paragraph.replace(PATH, " "))
      for (const sentence of paragraph.split(/(?<=[.!?;])\s+|\n+/)) {
        // Per sentence, not over the whole document: the window between a verb
        // and its preposition is bounded, and this hook runs on every request.
        intent ||= INTENT.test(sentence)
        const verbs = [
          ...[...sentence.matchAll(INPUT)].map((match) => ({ index: match.index, input: true })),
          ...[...sentence.matchAll(PRODUCES)].map((match) => ({ index: match.index, input: false })),
        ].sort((left, right) => left.index - right.index)
        const matches = [...sentence.matchAll(PATH)]
        // "named `X` and save it inside `/results/`": the directory is in the
        // sentence, not in the name, and the check would look in the wrong
        // place without it.
        const directory = sentence.match(DIRECTORY)
        const ranged = expandRange(sentence, matches)
        for (const [position, match] of matches.entries()) {
          const named = match[1]
          if (ranged?.template === named) continue
          if (runtime && !named.includes("/")) continue
          // The directory belongs to the name it follows, not to a file the
          // sentence goes on to mention.
          const placed =
            directory &&
            directory.index !== undefined &&
            !named.includes("/") &&
            (match.index < directory.index ||
              // "Write four artifacts to `/root/results/`: `a.mtx`, `b.tsv`":
              // the colon hands the directory to the names that follow.
              /^\s*:/.test(sentence.slice(directory.index + directory[0].length)))
          const candidate = placed
            ? `${directory[1]}${named}`
            : !named.includes("/") && sections.placed.has(named)
              ? sections.placed.get(named)!
              : named
          if (/^(?:https?|www\.)/i.test(candidate) || candidate.includes("://")) continue
          if (PLACEHOLDER_PATH.test(candidate)) continue
          // A path named in a sentence that waives it ("skip X for now") is the
          // user's decision, not a missing deliverable.
          if (NEGATED.test(sentence.slice(Math.max(0, match.index - NEGATION_WINDOW), match.index))) {
            waived.add(candidate)
            continue
          }
          const verb = verbs.filter((entry) => entry.index < match.index).at(-1)
          // The window ends at the next path, so "a.npz and b.py, which you must
          // edit" attaches the verb to b.py alone.
          const after = match.index + match[0].length
          const edited = EDITED.test(
            sentence.slice(after, Math.min(after + EDIT_WINDOW, matches[position + 1]?.index ?? sentence.length)),
          )
          // The verb governing this path outranks the section it sits in: a
          // file the task says to write is a deliverable even when it was also
          // listed among the inputs, and one it says to read is not owed even
          // under an outputs heading. With no verb, the section decides, and a
          // file listed among the inputs stays one when an output's bullet
          // mentions it again ("derived from `counts.csv`").
          // The names a range instantiates stand in for its two endpoints.
          const candidates = ranged?.endpoints.has(named)
            ? ranged.names.map((name) => `${ranged.directory}${name}`)
            : [candidate]
          if ((verb && !verb.input) || edited) produced.push(...candidates)
          else if (verb?.input || sections.inputs.has(candidate)) continue
          else if (sections.outputs.has(candidate)) produced.push(...candidates)
          else neutral.push(...candidates)
        }
      }
    }
    // When the task names what it wants produced, those are the deliverables;
    // paths with no verb at all are context, not debts. A bare file name that
    // a fuller path already covers ("predict.py" after "/app/submission/predict.py")
    // is the same debt, and would be looked for in the wrong place.
    const keep = (values: string[]) => [...new Set(values)].filter((value) => !waived.has(value))
    const dedupe = (values: string[]) =>
      values.filter((value) => value.includes("/") || !values.some((other) => other.endsWith(`/${value}`)))
    // A bare name the request owes ("you may edit `Basic.lean`") is the file
    // the request spelled in full elsewhere, even where that fuller mention
    // carried no verb of its own.
    const mentioned = [...new Set([...produced, ...neutral])]
    const fuller = (value: string) =>
      value.includes("/") ? value : (mentioned.find((other) => other.endsWith(`/${value}`)) ?? value)
    const owed = keep(produced.map(fuller))
    if (owed.length) return dedupe(owed)
    const paths = keep(neutral)
    if (!paths.length) return []
    // A lone verbless mention is context; two mentions, or one beside format
    // language, read as a specification. The bare repeat of a path counts as
    // a mention here and is folded into the fuller path afterwards.
    if (!intent && !SHAPE.test(text) && paths.length < 2) return []
    return dedupe(paths)
  }

  export type Check = { path: string; problems: string[] }

  /** A comma- or tab-separated line of column names, as a request states one:
   * `well,n_cells_nuclei,n_cilia,ciliation_rate_pct`, `target_name,classification,Main physical period (day)`. */
  const HEADER_LINE = /^[A-Za-z_][\w .()%/-]*(?:[,\t][A-Za-z_][\w .()%/-]*)+$/

  /** The header a request states for each CSV/TSV deliverable, when it does:
   * the fenced block after the path whose first line is a column list (alone,
   * or followed by a few example rows), or an inline "columns `a,b`". A
   * grader that names a header wants it exactly; a mechanical check before the
   * turn ends is cheaper than the zero. */
  export function headers(text: string, outputs: string[]): Record<string, string> {
    const lines = text.split("\n")
    const out: Record<string, string> = {}
    for (const name of outputs) {
      if (![".csv", ".tsv"].includes(path.extname(name).toLowerCase())) continue
      const at = lines.findIndex((line) => line.includes(name))
      if (at < 0) continue
      for (let i = at; i < Math.min(lines.length, at + 16) && !(name in out); i++) {
        const inline = lines[i].match(/columns?\s+`([^`]+)`/i)
        if (inline && HEADER_LINE.test(inline[1].trim())) {
          out[name] = inline[1].trim()
          break
        }
        if (!/^\s{0,8}(`{3,}|~{3,})/.test(lines[i])) continue
        const body: string[] = []
        let j = i + 1
        for (; j < lines.length && !/^\s{0,8}(`{3,}|~{3,})/.test(lines[j]); j++) body.push(lines[j].trim())
        const first = body.find((line) => line.length)
        // One line, or a header followed by up to five example rows of the same width.
        const rows = body.filter((line) => line.length && !/^(\.\.\.|…)$/.test(line))
        if (first && HEADER_LINE.test(first) && rows.length <= 6) {
          const width = first.split(/[,\t]/).length
          if (rows.slice(1).every((row) => row.split(/[,\t]/).length === width)) out[name] = first
        }
        i = j
      }
    }
    return out
  }

  /** The columns a stated header names, split on whatever separates them. */
  export function columns(header: string): string[] {
    return header.split(header.includes("\t") ? "\t" : ",").map((cell) => cell.trim())
  }

  async function parseCheck(file: string, bytes: Uint8Array, header?: string): Promise<string[]> {
    const ext = path.extname(file).toLowerCase()
    const text = () => new TextDecoder().decode(bytes)
    if (ext === ".json") {
      try {
        JSON.parse(text())
        return []
      } catch (error) {
        return [`does not parse as JSON (${error instanceof Error ? error.message.split("\n")[0] : "invalid"})`]
      }
    }
    if (ext === ".jsonl") {
      const bad = text()
        .split("\n")
        .filter((line) => line.trim())
        .findIndex((line) => {
          try {
            JSON.parse(line)
            return false
          } catch {
            return true
          }
        })
      return bad === -1 ? [] : [`line ${bad + 1} does not parse as JSON`]
    }
    if (ext === ".csv" || ext === ".tsv") {
      const separator = ext === ".csv" ? "," : "\t"
      const lines = text()
        .split(/\r?\n/)
        .filter((line) => line.length)
      if (lines.length < 2) return ["has a header but no data rows"]
      const width = lines[0].split(separator).length
      const problems: string[] = []
      const ragged = lines.findIndex((line) => line.split(separator).length !== width)
      if (ragged > 0 && !lines[ragged].includes('"')) problems.push(`row ${ragged + 1} has a different column count`)
      if (lines.some((line) => NAN.test(line))) problems.push("contains NaN or Inf values")
      const actual = lines[0].split(separator).map((cell) => cell.trim())
      if (header) {
        const stated = columns(header)
        if (actual.length !== stated.length || actual.some((cell, index) => cell !== stated[index]))
          problems.push(`header is "${actual.join(",")}" but the request states "${stated.join(",")}"`)
      }
      // No uniqueness check on an id column: a long table repeats its
      // patient, sample or cell id by design (one row per bin, per state, per
      // timepoint), and a lead told otherwise spent its last rounds arguing
      // with the checklist instead of finishing. The verifier owns row keys.
      return problems
    }
    if (ext === ".npy") return bytes[0] === 0x93 && text().slice(1, 6) === "NUMPY" ? [] : ["is not a NumPy .npy file"]
    if (ext === ".npz" || ext === ".zip") return bytes[0] === 0x50 && bytes[1] === 0x4b ? [] : ["is not a zip archive"]
    if (ext === ".parquet") {
      const head = new TextDecoder().decode(bytes.subarray(0, 4))
      const tail = new TextDecoder().decode(bytes.subarray(bytes.length - 4))
      return head === "PAR1" && tail === "PAR1" ? [] : ["is not a Parquet file"]
    }
    if (ext === ".toml") {
      try {
        Bun.TOML.parse(text())
        return []
      } catch {
        return ["does not parse as TOML"]
      }
    }
    if (ext === ".yaml" || ext === ".yml") {
      const yaml = (Bun as unknown as { YAML?: { parse(text: string): unknown } }).YAML
      if (!yaml) return []
      try {
        yaml.parse(text())
        return []
      } catch {
        return ["does not parse as YAML"]
      }
    }
    if (ext === ".png") return bytes[0] === 0x89 && bytes[1] === 0x50 ? [] : ["is not a PNG image"]
    if (ext === ".pdf") return text().startsWith("%PDF") ? [] : ["is not a PDF"]
    return []
  }

  /** Where a relative output may live: the tool directory first, then the
   * project's files, without duplicates. */
  export async function roots(sessionID: string): Promise<string[]> {
    const tool = await SessionFilesystem.toolDirectory(sessionID).catch(() => undefined)
    const project = Instance.directory
    return [...new Set([tool, project].filter((value): value is string => !!value))]
  }

  /** The check of one named output across the places it may live: the first
   * passing result wins; otherwise the first root's problems are reported,
   * with "does not exist" only when it exists nowhere. */
  export async function checkIn(roots: string[], name: string, header?: string): Promise<Check> {
    const results = await Promise.all(roots.map((root) => check(root, name, header)))
    const passed = results.find((result) => result.problems.length === 0)
    if (passed) return passed
    // An absolute output the request itself names outside every root
    // (`/results/answers.csv` beside a project in `/app`) is still owed, and
    // still not this session's to open: its presence is checked, its content
    // is not read.
    if (path.isAbsolute(name) && results.every((result) => result.problems.includes("is outside allowed output roots")))
      return presence(name)
    const present = results.find(
      (result) =>
        !result.problems.includes("does not exist") && !result.problems.includes("is outside allowed output roots"),
    )
    const missing = results.find((result) => result.problems.includes("does not exist"))
    return present ?? missing ?? results[0] ?? { path: name, problems: ["does not exist"] }
  }

  async function presence(name: string): Promise<Check> {
    const link = await fs.lstat(name).catch(() => undefined)
    if (!link) return { path: name, problems: ["does not exist"] }
    if (link.isSymbolicLink()) return { path: name, problems: ["is a symlink, not a regular file"] }
    if (!link.isFile()) return { path: name, problems: ["is not a regular file"] }
    return { path: name, problems: link.size === 0 ? ["is empty"] : [] }
  }

  /** Mechanical checks for one named output; an empty list means it passed. */
  export async function check(root: string, name: string, header?: string): Promise<Check> {
    // The checklist is the request's own words, so a named output may point
    // out of the root with `..` or through a symlink. Resolve it by identity
    // and refuse it before anything is read: an output that is not under an
    // approved root is not this session's to open.
    const allowed = await Filesystem.canonical(root)
    const target = path.isAbsolute(name) ? name : path.resolve(root, name)
    const outside = { path: name, problems: ["is outside allowed output roots"] }
    if (!allowed || (!Filesystem.contains(path.resolve(root), target) && !Filesystem.contains(allowed, target)))
      return outside
    // lstat, not stat: a symlink to a good file satisfies stat and is still
    // rejected by anything that opens deliverables with O_NOFOLLOW or asks for
    // a regular file, which is the common contract for collected outputs.
    const link = await fs.lstat(target).catch(() => undefined)
    if (link?.isSymbolicLink()) return { path: name, problems: ["is a symlink, not a regular file"] }
    const file = await Filesystem.canonical(target)
    if (!file || !Filesystem.contains(allowed, file)) return outside
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat) return { path: name, problems: ["does not exist"] }
    if (!stat.isFile()) return { path: name, problems: ["is not a regular file"] }
    if (stat.size === 0) return { path: name, problems: ["is empty"] }
    if (stat.size > MAX_BYTES) return { path: name, problems: [] }
    const bytes = new Uint8Array(await fs.readFile(file))
    const problems = await parseCheck(file, bytes, header)
    const ext = path.extname(file).toLowerCase()
    const textual = [
      ".csv",
      ".tsv",
      ".json",
      ".jsonl",
      ".md",
      ".txt",
      ".yaml",
      ".yml",
      ".toml",
      ".tex",
      ".bib",
      ".html",
    ]
    if (textual.includes(ext) && PLACEHOLDER.test(new TextDecoder().decode(bytes))) {
      problems.push("contains placeholder text (TODO, TBD, placeholder, dummy or similar)")
    }
    return { path: name, problems }
  }

  /** The `<env>` line naming what the harness will check. Saying it once, in
   * the cached prefix, lets the model see the same contract the check will
   * use and notice immediately if the request means something else. */
  export function envLine(deliverables: string[], limit = 8) {
    if (!deliverables.length) return []
    const shown = deliverables.slice(0, limit)
    const rest = deliverables.length - shown.length
    return [
      `Named outputs: ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}` +
        ` — checked for existence, format and placeholder values before this turn ends; produce anything else the request asks for as well.`,
    ]
  }

  export function render(failures: Check[]) {
    return [
      "Before finishing, the deliverables checklist was checked mechanically. These named outputs are not ready:",
      ...failures.map((failure) => `- ${failure.path}: ${failure.problems.join("; ")}`),
      "Produce the real file for each, or state precisely why it cannot be produced; do not write placeholder values. A graded output that does not exist is a zero whatever the others contain: write a complete valid version of every named output first, then improve it in place.",
    ].join("\n")
  }
}

export const DeliverablesUnit: Plugin = async () => {
  const hooks: Hooks = {
    async "chat.message"(input, output) {
      const state = HarnessState.get(input.sessionID)
      if (state.deliverables.length) return
      // A worker's brief is written by the lead and names the files it may
      // touch or must read; the lead holds the checklist for the user's
      // request and checks the deliverables it asked for itself.
      const session = await Session.get(input.sessionID).catch(() => undefined)
      if (session?.parentID) return
      // Only the person's own words specify deliverables. A synthetic prompt
      // (a worker's report waking the lead, a harness continuation) is full
      // of paths it discusses, none of which the user asked for.
      const spoken = output.parts.filter(
        (part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic,
      )
      if (!spoken.length) return
      // Only the first real request defines the deliverables; later turns may
      // steer the work but the checklist stays anchored to what was asked.
      // Every prompt carries an `internal` marker for restart replay, so the
      // anchor is the first user message with text the person typed.
      const earlier = (await Session.messages({ sessionID: input.sessionID }).catch(() => [])).filter(
        (message) =>
          message.info.role === "user" &&
          message.info.id !== output.message.id &&
          message.info.internal?.type !== "continuation" &&
          message.parts.some((part) => part.type === "text" && !part.synthetic),
      )
      if (earlier.length) return
      const text = spoken.map((part) => part.text).join("\n")
      state.deliverables = Deliverables.detect(text)
      state.deliverableHeaders = Deliverables.headers(text, state.deliverables)
    },
    async "env.lines"(input, output) {
      output.lines.push(...Deliverables.envLine(HarnessState.get(input.sessionID).deliverables))
    },
    async "loop.before_finish"(input, output) {
      const state = HarnessState.get(input.sessionID)
      if (!state.deliverables.length) return
      // A relative output may sit in the tool directory or in the project's
      // files: the environment names both, and an isolated session's agent
      // rightly puts durable deliverables in the project rather than its
      // scratch. A file that passes in either place is ready; checking the
      // scratch alone sent one agent off to duplicate finished files there.
      const roots = await Deliverables.roots(input.sessionID)
      if (!roots.length) return
      const checks = await Promise.all(
        state.deliverables.map((name) => Deliverables.checkIn(roots, name, state.deliverableHeaders?.[name])),
      )
      const failures = checks.filter((check) => check.problems.length)
      state.deliverablesFailing = failures.length > 0
      if (!failures.length || state.deliverableRounds >= 2) return
      state.deliverableRounds++
      output.message = Deliverables.render(failures)
    },
    async event({ event }) {
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
    },
  }
  return hooks
}
