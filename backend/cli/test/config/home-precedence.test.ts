import { expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"

for (const layer of ["home", "canonical", "project", "hidden", "inline", "explicit"] as const) {
  test(`legacy home config stays below the ${layer} layer`, async () => {
    await using tmp = await tmpdir()
    const home = path.join(tmp.path, "home")
    const project = path.join(tmp.path, "project")
    const canonical = path.join(tmp.path, "config", "openscience")
    const write = (directory: string, model: string) =>
      Bun.write(
        path.join(directory, "openscience.json"),
        JSON.stringify({ model, command: { example: { template: model } } }),
      )
    await write(path.join(home, ".synsc"), "legacy")
    await write(path.join(home, ".openscience"), "home")
    await Bun.write(path.join(home, ".openscience", "command", "example.md"), "home")
    await Bun.write(path.join(project, "README.md"), "fixture")
    if (layer !== "home") await write(canonical, "canonical")
    if (["project", "hidden", "inline"].includes(layer)) await write(project, "project")
    if (["hidden", "inline"].includes(layer)) await write(path.join(project, ".openscience"), "hidden")
    if (layer === "explicit") await write(path.join(tmp.path, "explicit"), "explicit")
    const config = pathToFileURL(path.resolve(import.meta.dir, "../../src/config/config.ts")).href
    const instance = pathToFileURL(path.resolve(import.meta.dir, "../../src/project/instance.ts")).href
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { Config } from ${JSON.stringify(config)};
       import { Instance } from ${JSON.stringify(instance)};
       await Instance.provide({ directory: ${JSON.stringify(project)}, fn: async () => {
         const config = await Config.get();
         console.log(JSON.stringify({ model: config.model, template: config.command.example.template }));
       }}); process.exit(0);`,
      ],
      {
        cwd: tmp.path,
        env: {
          ...process.env,
          OPENSCIENCE_TEST_HOME: home,
          OPENSCIENCE_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
          OPENSCIENCE_DATA_DIR: path.join(tmp.path, "data"),
          OPENSCIENCE_CONFIG: "",
          OPENSCIENCE_CONFIG_DIR: layer === "explicit" ? path.join(tmp.path, "explicit") : "",
          OPENSCIENCE_CONFIG_CONTENT:
            layer === "inline" ? JSON.stringify({ model: "inline", command: { example: { template: "inline" } } }) : "",
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
    expect(JSON.parse(output.trim())).toEqual({ model: layer, template: layer })
  })
}
