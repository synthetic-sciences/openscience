import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import config, { workspaceManualChunks, workspaceServerAllow } from "../vite.config"

test("Vite keeps the complete Molstar package in one explicit chunk", () => {
  expect(workspaceManualChunks("/repo/node_modules/molstar/lib/mol-plugin/context.js")).toBe("molstar")
  expect(
    workspaceManualChunks(
      "/repo/node_modules/.bun/molstar@5.10.1/node_modules/molstar/lib/mol-plugin-state/builder.js",
    ),
  ).toBe("molstar")
  expect(workspaceManualChunks("C:\\repo\\node_modules\\molstar\\lib\\mol-model\\structure.js")).toBe("molstar")
  expect(workspaceManualChunks("/repo/node_modules/molstar-adjacent/index.js")).toBeUndefined()

  const output = config.build?.rollupOptions?.output
  expect(Array.isArray(output)).toBe(false)
  if (!output || Array.isArray(output)) throw new Error("Expected one Rollup output configuration")
  expect(output.onlyExplicitManualChunks).toBe(true)
  expect(output.manualChunks).toBe(workspaceManualChunks)
})

test("Vite pre-bundles RDKit before a module worker requests it", () => {
  expect(config.optimizeDeps?.include).toContain("@rdkit/rdkit")
  expect(config.server?.fs?.allow).toEqual(workspaceServerAllow())
})

function packageName(node: ts.Expression | undefined) {
  return node && ts.isStringLiteral(node) ? node.text : undefined
}

function isMolstar(value: string | undefined) {
  return value === "molstar" || value?.startsWith("molstar/") === true
}

function importHasRuntimeBindings(node: ts.ImportDeclaration) {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings) return false
  if (ts.isNamespaceImport(bindings)) return true
  return bindings.elements.some((item) => !item.isTypeOnly)
}

function exportHasRuntimeBindings(node: ts.ExportDeclaration) {
  if (node.isTypeOnly) return false
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true
  return node.exportClause.elements.some((item) => !item.isTypeOnly)
}

test("workspace source has no static runtime import that pulls Molstar into an entry chunk", async () => {
  const root = new URL("../", import.meta.url)
  const offenders: string[] = []
  for await (const relative of new Bun.Glob("src/**/*.{ts,tsx}").scan({
    cwd: fileURLToPath(root),
    onlyFiles: true,
  })) {
    const source = await Bun.file(new URL(relative, root)).text()
    const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    for (const statement of file.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        isMolstar(packageName(statement.moduleSpecifier)) &&
        importHasRuntimeBindings(statement)
      ) {
        offenders.push(relative)
      }
      if (
        ts.isExportDeclaration(statement) &&
        isMolstar(packageName(statement.moduleSpecifier)) &&
        exportHasRuntimeBindings(statement)
      ) {
        offenders.push(relative)
      }
    }
  }

  expect(offenders).toEqual([])
})
