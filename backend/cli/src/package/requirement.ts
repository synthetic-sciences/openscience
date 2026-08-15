/**
 * A deliberate PEP 508 subset: name, extras, version specifiers, environment
 * markers, and the `name @ url` direct-reference form. Markers are captured but
 * never evaluated — nothing here needs to.
 *
 * The spec's requirement is "parse with a real parser", meaning specifically:
 * do not split on `==`. A split mishandles `numpy>=2.4`, `pandas[performance]`
 * and `tqdm; python_version >= "3.9"`, and a mis-parsed name becomes a wrong
 * permission pattern — an approval for something other than what runs. So
 * anything outside this grammar throws rather than being guessed at.
 */
export namespace Requirement {
  export type Parsed = {
    name: string
    extras: string[]
    specifier: string
    marker: string
    url: string
  }

  /**
   * PEP 503 normalisation: runs of `-`, `_` and `.` collapse to one `-`, and
   * comparison is lowercase. `Foo_Bar`, `Foo.Bar` and `foo-bar` are one
   * package. Treating them as three would let an upgrade look additive to
   * `Environment.additive`, which decides whether live kernels restart.
   */
  const normalise = (value: string) => value.replace(/[-_.]+/g, "-").toLowerCase()

  const NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/

  /**
   * One comparison clause, anchored end to end: an operator followed by a
   * version that actually starts with an alphanumeric.
   *
   * Anchoring matters more than it looks. A prefix test like
   * `/^(===|==|…|>|<)\s*\S/` accepts `numpy >= ` — the alternation backtracks
   * to the single-character `>` and then happily consumes the `=` as the
   * version. A dangling operator would then reach pip as a literal
   * requirement, having passed validation.
   */
  const CLAUSE = /^(===|==|!=|~=|>=|<=|>|<)\s*[A-Za-z0-9][A-Za-z0-9.*+!_-]*$/

  /** Every comma-separated clause must be well formed — `>=2.1,<3` is two. */
  const valid = (specifier: string) =>
    specifier
      .split(",")
      .map((clause) => clause.trim())
      .every((clause) => CLAUSE.test(clause))

  export function parse(value: string): Parsed {
    const text = value.trim()
    if (!text) throw new Error(`Not a package requirement: ${JSON.stringify(value)}`)

    const [head, ...rest] = text.split(";")
    const marker = rest.join(";").trim()
    const body = head!.trim()
    if (!body) throw new Error(`Not a package requirement: ${JSON.stringify(value)}`)

    const at = body.indexOf("@")
    if (at !== -1) {
      const name = body.slice(0, at).trim()
      const url = body.slice(at + 1).trim()
      if (!NAME.test(name) || !url) throw new Error(`Not a package requirement: ${JSON.stringify(value)}`)
      return { name: normalise(name), extras: [], specifier: "", marker, url }
    }

    const match = body.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/)
    if (!match) throw new Error(`Not a package requirement: ${JSON.stringify(value)}`)
    const [, raw, bracket, tail] = match
    if (!raw || !NAME.test(raw)) throw new Error(`Not a package requirement: ${JSON.stringify(value)}`)

    const extras = bracket
      ? bracket
          .slice(1, -1)
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
      : []

    const specifier = (tail ?? "").trim()
    if (specifier && !valid(specifier)) throw new Error(`Not a package requirement: ${JSON.stringify(value)}`)

    return { name: normalise(raw), extras, specifier: specifier.replace(/\s+/g, ""), marker, url: "" }
  }

  /**
   * Strip credentials and scheme from an index URL.
   *
   * Credentials are environment config, not part of the approved action:
   * rotating a token must not invalidate a standing grant, and a secret must
   * never be rendered on a card the user is about to screenshot.
   */
  export function redact(index: string) {
    const trimmed = index.trim()
    const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    const at = withoutScheme.lastIndexOf("@")
    return (at === -1 ? withoutScheme : withoutScheme.slice(at + 1)).replace(/\/+$/, "")
  }

  /**
   * The canonical command string — both what the approval card shows and what
   * the permission system matches. Readable on purpose, unlike a digest: change
   * the environment, the packages or the index and it is a different string, so
   * the prompt reappears for free.
   *
   * Names only, sorted. Sorted so the same set in a different argument order
   * matches an existing grant instead of prompting again; names only because
   * resolution happens after approval — the card shows the request, so pinning
   * a version must not fragment a grant the user already gave.
   */
  export function pattern(input: { packages: string[]; environment: string; index: string }) {
    const names = input.packages.map((p) => parse(p).name).toSorted()
    return `install ${names.join(" ")} → ${input.environment} [${input.index}]`
  }
}
