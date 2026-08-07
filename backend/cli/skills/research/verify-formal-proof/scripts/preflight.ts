#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"

const mode = process.argv[2]
const first = process.argv[3]
const second = process.argv[4]
if (!mode || !first || (mode === "submission" && !second)) {
  throw new Error(
    "Usage: bun scripts/preflight.ts protocol <manifest.json> | submission <preflight.json> <evidence.json>",
  )
}

const tiers = ["kernel", "fresh_recheck", "external_crosscheck"] as const
const relations = ["exact_proof", "exact_refutation", "repaired_proof"] as const
const roles = [
  "lean_kernel",
  "source_auditor",
  "axiom_auditor",
  "fresh_rechecker",
  "sandbox_comparator",
  "external_checker",
] as const
const files = [
  "challenge",
  "statement",
  "proof",
  "lean_toolchain",
  "lake_manifest",
  "dependency_tree",
  "config",
  "support",
] as const
const forbidden = ["sorry", "admit", "debug.skipKernelTC", "native_decide"] as const
const hash = (value: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const record = (value: unknown, label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const fields = (value: Record<string, unknown>, label: string, allowed: string[]) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`)
}
const text = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}
const integer = (value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return value as number
}
const boolean = (value: unknown, label: string) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`)
  return value
}
const choice = <T extends readonly string[]>(value: unknown, label: string, values: T) => {
  const item = text(value, label)
  if (!values.includes(item as T[number])) throw new Error(`${label} must be one of ${values.join(", ")}`)
  return item as T[number]
}
const target = (root: string, value: unknown, label: string) => {
  const input = text(value, label)
  if (path.isAbsolute(input)) throw new Error(`${label} must be relative to its evidence directory`)
  const file = path.resolve(root, input)
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes its evidence directory`)
  }
  return file
}
const bytes = async (root: string, value: unknown, label: string) => {
  const file = target(root, value, label)
  const boundary = await fs.realpath(root)
  const real = await fs.realpath(file)
  if (real !== boundary && !real.startsWith(`${boundary}${path.sep}`)) {
    throw new Error(`${label} resolves outside its evidence directory`)
  }
  const source = Bun.file(real)
  if (!(await source.exists())) throw new Error(`${label} does not exist: ${file}`)
  return new Uint8Array(await source.arrayBuffer())
}
const digest = async (root: string, value: unknown, label: string) => hash(await bytes(root, value, label))

async function protocol(file: string) {
  const input = record(await Bun.file(path.resolve(file)).json(), "manifest")
  fields(input, "manifest", [
    "tier",
    "relation",
    "challengePath",
    "statementPath",
    "declaration",
    "module",
    "leanVersion",
    "leanToolchainPath",
    "lakeManifestPath",
    "dependencyTreePath",
    "verifiers",
    "sandboxImagePath",
    "allowedAxioms",
    "maxFiles",
  ])
  const tier = choice(input.tier, "tier", tiers)
  const root = path.dirname(path.resolve(file))
  if (!Array.isArray(input.verifiers)) throw new Error("verifiers must be an array")
  const verifiers = await Promise.all(
    input.verifiers.map(async (value, index) => {
      const item = record(value, `verifiers[${index}]`)
      fields(item, `verifiers[${index}]`, ["role", "name", "version", "artifactPath"])
      return {
        role: choice(item.role, `verifiers[${index}].role`, roles),
        name: text(item.name, `verifiers[${index}].name`),
        version: text(item.version, `verifiers[${index}].version`),
        artifactSHA256: await digest(root, item.artifactPath, `verifiers[${index}].artifactPath`),
      }
    }),
  )
  if (!Array.isArray(input.allowedAxioms)) throw new Error("allowedAxioms must be an array")
  const allowedAxioms = input.allowedAxioms
    .map((item, index) => text(item, `allowedAxioms[${index}]`))
    .toSorted((a, b) => a.localeCompare(b))
  if (new Set(allowedAxioms).size !== allowedAxioms.length) throw new Error("allowedAxioms must be unique")
  if (allowedAxioms.includes("sorryAx")) throw new Error("allowedAxioms can never include sorryAx")
  return {
    protocolVersion: "formal-proof-v1" as const,
    language: "lean4" as const,
    tier,
    relation: choice(input.relation, "relation", relations),
    challengeSHA256: await digest(root, input.challengePath, "challengePath"),
    statementSHA256: await digest(root, input.statementPath, "statementPath"),
    declaration: text(input.declaration, "declaration"),
    module: text(input.module, "module"),
    leanVersion: text(input.leanVersion, "leanVersion"),
    leanToolchainSHA256: await digest(root, input.leanToolchainPath, "leanToolchainPath"),
    lakeManifestSHA256: await digest(root, input.lakeManifestPath, "lakeManifestPath"),
    dependencyTreeSHA256: await digest(root, input.dependencyTreePath, "dependencyTreePath"),
    verifiers,
    ...(tier === "external_crosscheck"
      ? { sandboxImageSHA256: await digest(root, input.sandboxImagePath, "sandboxImagePath") }
      : {}),
    forbiddenConstructs: forbidden,
    allowedAxioms,
    maxFiles: integer(input.maxFiles, "maxFiles", 6, 10_000),
    completeManifestRequired: true as const,
    warningPolicy: "fail" as const,
    semanticPolicy: "formal_statement_only" as const,
  }
}

async function submission(preflight: string, file: string) {
  const frozen = record(await Bun.file(path.resolve(preflight)).json(), "preflight")
  fields(frozen, "preflight", ["protocol"])
  const protocol = record(frozen.protocol, "preflight.protocol")
  const input = record(await Bun.file(path.resolve(file)).json(), "evidence")
  fields(input, "evidence", ["sessionID", "subject", "artifactPath", "manifest", "verification"])
  const root = path.dirname(path.resolve(file))
  const subject = record(input.subject, "subject")
  fields(subject, "subject", ["type", "id"])
  const manifest = record(input.manifest, "manifest")
  fields(manifest, "manifest", ["complete", "files"])
  if (!Array.isArray(manifest.files)) throw new Error("manifest.files must be an array")
  const listed = await Promise.all(
    manifest.files.map(async (value, index) => {
      const item = record(value, `manifest.files[${index}]`)
      fields(item, `manifest.files[${index}]`, ["path", "role"])
      return {
        path: text(item.path, `manifest.files[${index}].path`),
        role: choice(item.role, `manifest.files[${index}].role`, files),
        sha256: await digest(root, item.path, `manifest.files[${index}].path`),
      }
    }),
  )
  const ordered = listed.toSorted((left, right) => left.path.localeCompare(right.path))
  if (new Set(ordered.map((item) => item.path)).size !== ordered.length) throw new Error("manifest paths must be unique")
  const verification = record(input.verification, "verification")
  fields(verification, "verification", ["startedAt", "endedAt", "build", "source", "axioms", "fresh", "external"])
  const build = record(verification.build, "verification.build")
  fields(build, "verification.build", ["exitCode", "warnings", "transcriptPath"])
  const source = record(verification.source, "verification.source")
  fields(source, "verification.source", ["complete", "findings", "transcriptPath"])
  if (!Array.isArray(source.findings)) throw new Error("verification.source.findings must be an array")
  const findings = source.findings
    .map((value, index) => {
      const item = record(value, `verification.source.findings[${index}]`)
      fields(item, `verification.source.findings[${index}]`, ["construct", "path", "line"])
      return {
        construct: choice(item.construct, `verification.source.findings[${index}].construct`, forbidden),
        path: text(item.path, `verification.source.findings[${index}].path`),
        line: integer(item.line, `verification.source.findings[${index}].line`, 1),
      }
    })
    .toSorted((left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.construct.localeCompare(right.construct),
    )
  const findingKeys = findings.map((item) => `${item.path}\u0000${item.line}\u0000${item.construct}`)
  if (new Set(findingKeys).size !== findingKeys.length) throw new Error("source findings must be unique")
  const axioms = record(verification.axioms, "verification.axioms")
  fields(axioms, "verification.axioms", ["complete", "typesTraversed", "observed", "transcriptPath"])
  if (!Array.isArray(axioms.observed)) throw new Error("verification.axioms.observed must be an array")
  const observed = axioms.observed
    .map((item, index) => text(item, `axioms.observed[${index}]`))
    .toSorted((a, b) => a.localeCompare(b))
  if (new Set(observed).size !== observed.length) throw new Error("observed axioms must be unique")
  const verifiers = protocol.verifiers
  if (!Array.isArray(verifiers)) throw new Error("preflight.protocol.verifiers must be an array")
  const verifier = (role: string) => {
    const item = verifiers.find((value: unknown) => record(value, "preflight.protocol.verifier").role === role)
    if (!item) throw new Error(`preflight protocol has no ${role} verifier`)
    return text(record(item, `verifier.${role}`).artifactSHA256, `verifier.${role}.artifactSHA256`)
  }
  const fresh = verification.fresh ? record(verification.fresh, "verification.fresh") : undefined
  if (fresh) fields(fresh, "verification.fresh", ["fresh", "exitCode", "transcriptPath"])
  const external = verification.external ? record(verification.external, "verification.external") : undefined
  if (external) {
    fields(external, "verification.external", [
      "sandboxed",
      "challengeMatched",
      "proofTermPath",
      "transcriptPath",
      "checks",
    ])
  }
  if (external && !Array.isArray(external.checks)) throw new Error("verification.external.checks must be an array")
  const checks = external
    ? await Promise.all(
        (external.checks as unknown[]).map(async (value, index) => {
          const item = record(value, `verification.external.checks[${index}]`)
          fields(item, `verification.external.checks[${index}]`, ["role", "accepted", "transcriptPath"])
          const role = choice(item.role, `verification.external.checks[${index}].role`, [
            "lean_kernel",
            "external_checker",
          ] as const)
          return {
            role,
            verifierArtifactSHA256: verifier(role),
            accepted: boolean(item.accepted, `verification.external.checks[${index}].accepted`),
            transcriptSHA256: await digest(
              root,
              item.transcriptPath,
              `verification.external.checks[${index}].transcriptPath`,
            ),
          }
        }),
      )
    : undefined
  const artifactSHA256 = await digest(root, input.artifactPath, "artifactPath")
  return {
    submission: {
      sessionID: text(input.sessionID, "sessionID"),
      subject: {
        type: choice(subject.type, "subject.type", ["run", "candidate"] as const),
        id: text(subject.id, "subject.id"),
      },
      artifactSHA256,
      relation: text(protocol.relation, "protocol.relation"),
      challengeSHA256: text(protocol.challengeSHA256, "protocol.challengeSHA256"),
      statementSHA256: text(protocol.statementSHA256, "protocol.statementSHA256"),
      declaration: text(protocol.declaration, "protocol.declaration"),
      module: text(protocol.module, "protocol.module"),
      environment: {
        leanVersion: text(protocol.leanVersion, "protocol.leanVersion"),
        leanToolchainSHA256: text(protocol.leanToolchainSHA256, "protocol.leanToolchainSHA256"),
        lakeManifestSHA256: text(protocol.lakeManifestSHA256, "protocol.lakeManifestSHA256"),
        dependencyTreeSHA256: text(protocol.dependencyTreeSHA256, "protocol.dependencyTreeSHA256"),
      },
      manifest: { complete: boolean(manifest.complete, "manifest.complete"), files: ordered },
      verification: {
        startedAt: integer(verification.startedAt, "verification.startedAt", 1),
        endedAt: integer(verification.endedAt, "verification.endedAt", 1),
        build: {
          verifierArtifactSHA256: verifier("lean_kernel"),
          exitCode: integer(build.exitCode, "verification.build.exitCode", -2147483648, 2147483647),
          warnings: integer(build.warnings, "verification.build.warnings"),
          transcriptSHA256: await digest(root, build.transcriptPath, "verification.build.transcriptPath"),
        },
        source: {
          verifierArtifactSHA256: verifier("source_auditor"),
          complete: boolean(source.complete, "verification.source.complete"),
          findings,
          transcriptSHA256: await digest(root, source.transcriptPath, "verification.source.transcriptPath"),
        },
        axioms: {
          verifierArtifactSHA256: verifier("axiom_auditor"),
          complete: boolean(axioms.complete, "verification.axioms.complete"),
          typesTraversed: boolean(axioms.typesTraversed, "verification.axioms.typesTraversed"),
          observed,
          transcriptSHA256: await digest(root, axioms.transcriptPath, "verification.axioms.transcriptPath"),
        },
        ...(fresh
          ? {
              fresh: {
                verifierArtifactSHA256: verifier("fresh_rechecker"),
                fresh: boolean(fresh.fresh, "verification.fresh.fresh"),
                exitCode: integer(fresh.exitCode, "verification.fresh.exitCode", -2147483648, 2147483647),
                transcriptSHA256: await digest(root, fresh.transcriptPath, "verification.fresh.transcriptPath"),
              },
            }
          : {}),
        ...(external && checks
          ? {
              external: {
                comparatorArtifactSHA256: verifier("sandbox_comparator"),
                sandboxImageSHA256: text(protocol.sandboxImageSHA256, "protocol.sandboxImageSHA256"),
                sandboxed: boolean(external.sandboxed, "verification.external.sandboxed"),
                challengeMatched: boolean(external.challengeMatched, "verification.external.challengeMatched"),
                proofTermSHA256: await digest(root, external.proofTermPath, "verification.external.proofTermPath"),
                transcriptSHA256: await digest(root, external.transcriptPath, "verification.external.transcriptPath"),
                checks,
              },
            }
          : {}),
      },
    },
    preview: {
      tier: protocol.tier,
      relation: protocol.relation,
      files: ordered.length,
      observedAxioms: observed,
      artifactSHA256,
    },
  }
}

if (mode === "protocol") console.log(JSON.stringify({ protocol: await protocol(first) }, null, 2))
else if (mode === "submission") console.log(JSON.stringify(await submission(first, second!), null, 2))
else throw new Error(`Unknown mode ${mode}`)
