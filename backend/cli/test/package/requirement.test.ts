import { expect, test } from "bun:test"
import { Requirement } from "../../src/package/requirement"

test("a bare name", () => {
  expect(Requirement.parse("numpy")).toEqual({ name: "numpy", extras: [], specifier: "", marker: "", url: "" })
})

test("a version specifier is kept whole, not split on ==", () => {
  // The exact case a naive `split("==")` gets wrong.
  expect(Requirement.parse("numpy>=2.4")).toMatchObject({ name: "numpy", specifier: ">=2.4" })
})

test.each([
  ["numpy==2.1.0", "==2.1.0"],
  ["numpy!=2.0.0", "!=2.0.0"],
  ["numpy~=2.1", "~=2.1"],
  ["numpy<3", "<3"],
  ["numpy<=3", "<=3"],
  ["numpy>2", ">2"],
  ["numpy===2.1.0", "===2.1.0"],
  ["numpy>=2.1,<3", ">=2.1,<3"],
])("parses the specifier in %s", (input, specifier) => {
  expect(Requirement.parse(input)).toMatchObject({ name: "numpy", specifier })
})

test("extras are captured and not folded into the name", () => {
  expect(Requirement.parse("pandas[performance,excel]")).toMatchObject({
    name: "pandas",
    extras: ["performance", "excel"],
  })
})

test("extras combine with a specifier", () => {
  expect(Requirement.parse("pandas[performance]>=2.2")).toMatchObject({
    name: "pandas",
    extras: ["performance"],
    specifier: ">=2.2",
  })
})

test("an environment marker is separated from the specifier", () => {
  expect(Requirement.parse('tqdm>=4 ; python_version >= "3.9"')).toMatchObject({
    name: "tqdm",
    specifier: ">=4",
    marker: 'python_version >= "3.9"',
  })
})

test("a direct URL reference keeps the name and the url apart", () => {
  expect(Requirement.parse("mypkg @ https://example.com/mypkg-1.0-py3-none-any.whl")).toMatchObject({
    name: "mypkg",
    url: "https://example.com/mypkg-1.0-py3-none-any.whl",
  })
})

test("names normalise per PEP 503 so Foo_Bar and foo-bar are one package", () => {
  // Treating them as different packages would let an upgrade look additive.
  expect(Requirement.parse("Foo_Bar").name).toBe("foo-bar")
  expect(Requirement.parse("Foo.Bar").name).toBe("foo-bar")
  expect(Requirement.parse("FOO---BAR").name).toBe("foo-bar")
})

test.each([[""], ["  "], ["=="], ["numpy=="], ["-rrequirements.txt"], ["numpy >= "], ["[extras]"], ["@ https://x"]])(
  "rejects %p rather than guessing",
  (input) => {
    // A silently mis-parsed name becomes a wrong permission pattern, and a
    // wrong pattern approves something other than what runs.
    expect(() => Requirement.parse(input)).toThrow()
  },
)

test.each([["numpy >= "], ["numpy>="], ["numpy<="], ["numpy=="], ["numpy~="], ["numpy>=2.1,"], ["numpy>=2.1,<"]])(
  "rejects the dangling operator in %p",
  (input) => {
    // Regression: a prefix test like /^(===|==|…|>|<)\s*\S/ accepts these,
    // because the alternation backtracks to the single-character `>` and
    // consumes the `=` as the version. The clause regex is anchored end to end
    // precisely to stop that — a dangling operator would otherwise reach pip
    // as a literal requirement, having passed validation.
    expect(() => Requirement.parse(input)).toThrow()
  },
)

test("a multi-clause specifier is validated clause by clause", () => {
  expect(Requirement.parse("numpy>=2.1,<3").specifier).toBe(">=2.1,<3")
  expect(() => Requirement.parse("numpy>=2.1,<")).toThrow()
})

test("the canonical pattern is exactly the spec's string", () => {
  expect(Requirement.pattern({ packages: ["numpy", "pandas"], environment: "default", index: "pypi.org/simple" })).toBe(
    "install numpy pandas → default [pypi.org/simple]",
  )
})

test("the pattern is stable under argument order, so the same request matches the same grant", () => {
  const a = Requirement.pattern({ packages: ["pandas", "numpy"], environment: "default", index: "pypi.org/simple" })
  const b = Requirement.pattern({ packages: ["numpy", "pandas"], environment: "default", index: "pypi.org/simple" })
  expect(a).toBe(b)
})

test("the pattern drops version specifiers, matching what the card shows", () => {
  // Resolution happens after approval — the card shows the request, so pinning
  // a version must not fragment an existing grant.
  const a = Requirement.pattern({ packages: ["numpy>=2.4"], environment: "default", index: "pypi.org/simple" })
  const b = Requirement.pattern({ packages: ["numpy"], environment: "default", index: "pypi.org/simple" })
  expect(a).toBe(b)
})

test("changing the environment changes the pattern, so the prompt reappears", () => {
  const a = Requirement.pattern({ packages: ["numpy"], environment: "default", index: "pypi.org/simple" })
  const b = Requirement.pattern({ packages: ["numpy"], environment: "torch", index: "pypi.org/simple" })
  expect(a).not.toBe(b)
})

test("changing the index changes the pattern", () => {
  const a = Requirement.pattern({ packages: ["numpy"], environment: "default", index: "pypi.org/simple" })
  const b = Requirement.pattern({ packages: ["numpy"], environment: "default", index: "pypi.internal/simple" })
  expect(a).not.toBe(b)
})

test("index credentials are redacted, never shown on the card", () => {
  const redacted = Requirement.redact("https://user:s3cret@pypi.internal/simple")
  expect(redacted).toBe("pypi.internal/simple")
  expect(redacted).not.toContain("s3cret")
  expect(redacted).not.toContain("user")
})

test("a bare index is unchanged by redaction apart from its scheme", () => {
  expect(Requirement.redact("https://pypi.org/simple/")).toBe("pypi.org/simple")
})

test("a credentialled index and a differently-credentialled one produce the same pattern", () => {
  // Credentials are environment config, not part of the approved action —
  // rotating a token must not invalidate a standing grant.
  const a = Requirement.pattern({
    packages: ["numpy"],
    environment: "default",
    index: Requirement.redact("https://user:s3cret@pypi.internal/simple"),
  })
  const b = Requirement.pattern({
    packages: ["numpy"],
    environment: "default",
    index: Requirement.redact("https://other:tok@pypi.internal/simple"),
  })
  expect(a).toBe(b)
})
