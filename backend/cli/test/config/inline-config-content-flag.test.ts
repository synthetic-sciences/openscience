import { expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"

// A shell-quoting accident truncates the inline payload ("{"model":"). The
// unguarded JSON.parse rejected Config.get() with a bare SyntaxError, so every
// project instance failed to load and nothing named the layer at fault. Assert
// the codebase's own diagnostic reaches the operator instead.
async function loadWithContent(content: string) {
  await using tmp = await tmpdir()
  const project = path.join(tmp.path, "project")
  await Bun.write(path.join(project, "README.md"), "fixture")
  const config = pathToFileURL(path.resolve(import.meta.dir, "../../src/config/config.ts")).href
  const instance = pathToFileURL(path.resolve(import.meta.dir, "../../src/project/instance.ts")).href
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { Config } from ${JSON.stringify(config)};
       import { Instance } from ${JSON.stringify(instance)};
       await Instance.provide({ directory: ${JSON.stringify(project)}, fn: async () => {
         try {
           await Config.get();
           console.log(JSON.stringify({ loaded: true }));
         } catch (error) {
           console.log(JSON.stringify({
             loaded: false,
             name: error?.name,
             message: error?.message,
             path: error?.data?.path,
           }));
         }
       }}); process.exit(0);`,
    ],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        OPENSCIENCE_TEST_HOME: path.join(tmp.path, "home"),
        OPENSCIENCE_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        OPENSCIENCE_DATA_DIR: path.join(tmp.path, "data"),
        OPENSCIENCE_CONFIG: "",
        OPENSCIENCE_CONFIG_DIR: "",
        OPENSCIENCE_CONFIG_CONTENT: content,
        OPENSCIENCE_DISABLE_PROJECT_CONFIG: "false",
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        XDG_DATA_HOME: path.join(tmp.path, "share"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, error).toBe(0)
  return JSON.parse(output.trim())
}

test("truncated inline config content reports the failing config layer", async () => {
  const result = await loadWithContent('{"model":')

  expect(result.loaded).toBe(false)
  expect(result.name).toBe("ConfigJsonError")
  expect(result.path).toBe("OPENSCIENCE_CONFIG_CONTENT")
  // The underlying parse detail is carried through, but its wording is
  // runtime-specific (V8 says "Unexpected end of JSON input", Bun says
  // "JSON Parse error: Unexpected EOF"), so assert it is real detail rather
  // than the NamedError name fallback.
  expect(result.message).not.toBe("ConfigJsonError")
  expect(result.message.length).toBeGreaterThan(0)
})

test("valid inline config content still loads", async () => {
  const result = await loadWithContent(JSON.stringify({ model: "inline" }))

  expect(result.loaded).toBe(true)
})
