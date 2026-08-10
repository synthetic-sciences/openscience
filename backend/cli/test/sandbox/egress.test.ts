import { expect, test } from "bun:test"
import { Egress } from "../../src/sandbox/egress"

test("an exact rule matches only that host", () => {
  expect(Egress.allowed("pypi.org", ["pypi.org"])).toBe(true)
  expect(Egress.allowed("evil-pypi.org", ["pypi.org"])).toBe(false)
})

test("a leading dot matches the domain and its subdomains", () => {
  expect(Egress.allowed("eutils.ncbi.nlm.nih.gov", [".ncbi.nlm.nih.gov"])).toBe(true)
  expect(Egress.allowed("ncbi.nlm.nih.gov", [".ncbi.nlm.nih.gov"])).toBe(true)
  expect(Egress.allowed("ncbi.nlm.nih.gov.evil.com", [".ncbi.nlm.nih.gov"])).toBe(false)
})

test("a port on the authority is ignored when matching", () => {
  expect(Egress.allowed("pypi.org:443", ["pypi.org"])).toBe(true)
})

test("matching is case-insensitive in both directions", () => {
  expect(Egress.allowed("PyPI.ORG", ["pypi.org"])).toBe(true)
  expect(Egress.allowed("pypi.org", ["PyPI.ORG"])).toBe(true)
})

test("an empty ruleset allows nothing", () => {
  expect(Egress.allowed("pypi.org", [])).toBe(false)
})

test("the shipped defaults cover the registries and scientific APIs the product needs", () => {
  for (const host of [
    "pypi.org",
    "files.pythonhosted.org",
    "cran.r-project.org",
    "eutils.ncbi.nlm.nih.gov",
    "rest.uniprot.org",
  ]) {
    expect(Egress.allowed(host, Egress.DEFAULT_RULES)).toBe(true)
  }
})

test("the shipped defaults do not permit general browsing", () => {
  for (const host of ["example.com", "www.google.com", "raw.githubusercontent.com"]) {
    expect(Egress.allowed(host, Egress.DEFAULT_RULES)).toBe(false)
  }
})
