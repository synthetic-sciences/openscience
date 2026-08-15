import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Installer } from "../../src/package/installer"
import { InstallerR } from "../../src/package/installer-r"
import { tmpdir } from "../fixture/fixture"

const rscript = Bun.which("Rscript")
const read = (relative: string) => Bun.file(new URL(relative, import.meta.url).pathname).text()

test("the library path is derived from the environment directory, beside the interpreter", () => {
  // Both language backends derive their binding from one place, so a kernel can
  // resolve it before any install has ever run.
  expect(Installer.rlibrary("/envs/e")).toBe(path.join("/envs/e", "rlibs"))
})

test("the index is CRAN, asserted by value rather than by grepping for a domain", () => {
  // Equality on an exported constant, not `source.includes("cran...")`. The
  // substring form reads to CodeQL as incomplete URL sanitization — a false
  // positive, but the constant is the better design anyway: one named value
  // decides where packages come from, and it has to stay in step with
  // Egress.DEFAULT_RULES.
  expect(InstallerR.REPO).toBe("https://cran.r-project.org")
})

test("the index CRAN is allowlisted, or every R install fails closed", async () => {
  const { Egress } = await import("../../src/sandbox/egress")
  const host = new URL(InstallerR.REPO).hostname
  const allowed = Egress.allowed(host, Egress.DEFAULT_RULES)
  expect(allowed).toBe(true)
})

test("the install targets R_LIBS_USER, never the system library", async () => {
  const source = await read("../../src/package/installer-r.ts")
  // Writing to the system library would need root and would leak this
  // environment's packages into every other project on the machine.
  expect(source.includes("R_LIBS_USER")).toBe(true)
  expect(source.includes("install.packages")).toBe(true)
})

test("lib is passed explicitly, not left to .libPaths() ordering", async () => {
  const source = await read("../../src/package/installer-r.ts")
  // install.packages() otherwise picks the first writable entry of .libPaths(),
  // which on a machine with a user library already configured is the wrong
  // directory.
  expect(source.includes("lib = lib")).toBe(true)
})

test("a failed install is detected even though install.packages only warns", async () => {
  const source = await read("../../src/package/installer-r.ts")
  // install.packages() signals failure with a warning and still exits 0, so
  // without the explicit check a missing package reads as success.
  expect(source.includes("quit(status = 1)")).toBe(true)
})

test("explain names Bioconductor for a package CRAN does not have", () => {
  const log = "Warning message:\npackage ‘DESeq2’ is not available for this version of R"
  expect(InstallerR.explain(log)).toContain("Bioconductor")
})

test("explain surfaces a missing system header rather than the compile spew", () => {
  const log = ["  fatal error: libxml/parser.h: No such file or directory", "  compilation terminated."].join("\n")
  const message = InstallerR.explain(log)
  expect(message).toContain("libxml/parser.h")
  expect(message).toContain("system librar")
})

test("explain passes an unrecognised log through rather than inventing a diagnosis", () => {
  expect(InstallerR.explain("something nobody anticipated")).toContain("something nobody anticipated")
})

test.skipIf(!rscript)("an empty library reports no packages", async () => {
  await using dir = await tmpdir()
  const env = path.join(dir.path, "renv")
  await InstallerR.create(env)
  expect(await InstallerR.freeze(env)).toEqual({})
})

test.skipIf(!rscript)(
  "a package CRAN does not have fails rather than reporting success",
  async () => {
    await using dir = await tmpdir()
    const env = path.join(dir.path, "renv")
    const result = await InstallerR.install({ directory: env, packages: ["definitelyNotARealCranPackage"] })
    expect(result.ok).toBe(false)
    expect(await InstallerR.verify(env, ["definitelyNotARealCranPackage"])).toEqual({})
  },
  600_000,
)

test.skipIf(!rscript)(
  "a real CRAN package installs into the environment library and reports its version",
  async () => {
    // The gap the existing live tests left: both of them assert FAILURE paths
    // (an empty library, a package CRAN does not have), so nothing anywhere
    // proved an R install can succeed at all.
    //
    // `praise` is pure R, a few kilobytes, and has no dependencies — CRAN
    // serves Linux packages as source, so anything with compiled code would be
    // testing a toolchain rather than this installer.
    await using dir = await tmpdir()
    const env = path.join(dir.path, "renv")
    const result = await InstallerR.install({ directory: env, packages: ["praise"] })
    expect(result.ok, result.log).toBe(true)

    const versions = await InstallerR.verify(env, ["praise"])
    expect(versions["praise"]).toMatch(/^\d/)

    // It landed in the environment's own library, not a system or user one —
    // the whole point of passing `lib` explicitly rather than trusting
    // .libPaths() ordering.
    expect(Object.keys(await InstallerR.freeze(env))).toContain("praise")
    expect(fs.existsSync(path.join(Installer.rlibrary(env), "praise"))).toBe(true)
  },
  900_000,
)

test.skipIf(!rscript)(
  "a second package is additive alongside the first",
  async () => {
    // Mirrors the Python additivity check: the tool decides whether to restart
    // kernels from freeze() before and after, so an R install has to report a
    // growing set rather than replacing it.
    await using dir = await tmpdir()
    const env = path.join(dir.path, "renv")
    await InstallerR.install({ directory: env, packages: ["praise"] })
    const before = await InstallerR.freeze(env)
    await InstallerR.install({ directory: env, packages: ["R6"] })
    const after = await InstallerR.freeze(env)
    expect(Object.keys(after)).toContain("praise")
    expect(Object.keys(after)).toContain("R6")
    const { Environment } = await import("../../src/package/environment")
    expect(Environment.additive(before, after)).toBe(true)
  },
  900_000,
)
