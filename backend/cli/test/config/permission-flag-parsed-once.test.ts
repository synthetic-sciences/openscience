import { expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"

// OPENSCIENCE_PERMISSION was JSON.parse'd on two consecutive lines, so every
// config load parsed the same operator-supplied payload twice and a malformed
// value had to be parsed before anything could be reported. Count the parses
// that receive the exact payload and assert the value is still applied.
async function loadWithPermission(payload: string) {
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
       const payload = ${JSON.stringify(payload)};
       const original = JSON.parse;
       let parses = 0;
       JSON.parse = function (text, reviver) {
         if (text === payload) parses++;
         return original(text, reviver);
       };
       await Instance.provide({ directory: ${JSON.stringify(project)}, fn: async () => {
         try {
           const config = await Config.get();
           console.log(JSON.stringify({ loaded: true, parses, permission: config.permission }));
         } catch (error) {
           console.log(JSON.stringify({ loaded: false, parses, name: error?.name }));
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
        OPENSCIENCE_CONFIG_CONTENT: "",
        OPENSCIENCE_PERMISSION: payload,
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

test("the permission flag is parsed once and still applied", async () => {
  const payload = JSON.stringify({ edit: "ask", bash: "allow" })
  const result = await loadWithPermission(payload)

  expect(result.loaded).toBe(true)
  expect(result.parses).toBe(1)
  expect(result.permission).toMatchObject({ edit: "ask", bash: "allow" })
})
