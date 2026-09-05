import path from "node:path"
import ts from "typescript"

const root = path.resolve(import.meta.dir, "../../..")
const directory = path.join(root, "frontend/docs/src/content/openscience")
const examples = new Map<string, { source: string; page: string }>()
for (const file of new Bun.Glob("*.mdx").scanSync({ cwd: directory })) {
  const source = await Bun.file(path.join(directory, file)).text()
  for (const match of source.matchAll(/```typescript\n([\s\S]*?)\n```/g)) {
    const location = match[1].includes('"@synsci/plugin"') ? "tooling/plugin/src" : "tooling/sdk/js/src"
    const filename = path.join(root, location, "__docs_example_" + examples.size + ".ts")
    examples.set(filename, { source: match[1], page: file })
  }
}
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowImportingTsExtensions: true,
  types: ["node"],
  typeRoots: [path.join(root, "tooling/plugin/node_modules/@types")],
}
const host = ts.createCompilerHost(options)
const read = host.getSourceFile.bind(host)
host.getSourceFile = (filename, language, error, fresh) => {
  const example = examples.get(filename)
  return example
    ? ts.createSourceFile(filename, example.source, language, true)
    : read(filename, language, error, fresh)
}
const program = ts.createProgram([...examples.keys()], options, host)
const errors = ts.getPreEmitDiagnostics(program)
if (errors.length) {
  const message = ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => examples.get(file)?.page ?? file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  })
  throw new Error(message)
}
console.log("Typechecked " + examples.size + " TypeScript examples against the current SDK and plugin APIs.")
