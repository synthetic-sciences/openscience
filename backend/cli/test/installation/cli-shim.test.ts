import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CliShim } from "../../src/installation/cli-shim"
import { cleanShellConfig, getShellConfigFile } from "../../src/cli/cmd/uninstall"
import { Global } from "../../src/global"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

// A temporary home with an app bundle beside it, in the layout the packaged
// macOS app has. The shim only ever reads the bundle path, so the executable
// is a plain file.
async function fixture(input: { shell?: string; files?: Record<string, string>; env?: NodeJS.ProcessEnv } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-cli-shim-"))
  roots.push(root)
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true })
  for (const [name, content] of Object.entries(input.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true })
    await fs.writeFile(path.join(home, name), content)
  }
  const execPath = await bundle(root, "Applications")
  const env = { SHELL: `/bin/${input.shell ?? "zsh"}`, PATH: "/usr/bin:/bin", ...input.env }
  const options: CliShim.Options = { home, execPath, env, platform: "darwin" }
  return {
    root,
    home,
    execPath,
    options,
    bin: path.join(home, ".openscience", "bin"),
    link: path.join(home, ".openscience", "bin", "openscience"),
    file: (name: string) => Bun.file(path.join(home, name)).text(),
  }
}

// What `openscience uninstall` does about the PATH line: find the startup file
// that holds it, then take the block out. Returns the file it found.
async function uninstallPathLine(home: string, env: NodeJS.ProcessEnv | undefined) {
  const file = await getShellConfigFile({ home, env })
  if (file) await cleanShellConfig(file)
  return file
}

async function bundle(root: string, folder: string) {
  const execPath = path.join(root, folder, "OpenScience.app", "Contents", "Resources", "sidecar", "openscience")
  await fs.mkdir(path.dirname(execPath), { recursive: true })
  await fs.writeFile(execPath, "#!/bin/sh\n", { mode: 0o755 })
  return execPath
}

describe("CliShim", () => {
  test("installs the link and the installer's PATH line, once, for zsh", async () => {
    const f = await fixture({ files: { ".zshrc": "alias ll='ls -l'\n" } })
    const first = await CliShim.install(f.options)
    expect(await fs.readlink(f.link)).toBe(f.execPath)
    expect(first).toMatchObject({
      path: f.link,
      directory: f.bin,
      exists: true,
      target: f.execPath,
      current: true,
      ours: true,
      onPath: true,
      shell: "zsh",
      line: `export PATH=${f.bin}:$PATH`,
      config: path.join(f.home, ".zshrc"),
      installable: true,
    })
    expect(await f.file(".zshrc")).toBe(`alias ll='ls -l'\n\n# openscience\nexport PATH=${f.bin}:$PATH\n`)

    const second = await CliShim.install(f.options)
    expect(second).toEqual(first)
    expect(await f.file(".zshrc")).toBe(`alias ll='ls -l'\n\n# openscience\nexport PATH=${f.bin}:$PATH\n`)

    // The line is the one `openscience uninstall` takes back out.
    await cleanShellConfig(path.join(f.home, ".zshrc"))
    expect(await f.file(".zshrc")).toBe("alias ll='ls -l'\n")
  })

  test("names the installer's directory when nothing overrides the home", async () => {
    // No `home` and no `bin`: the directory a real install reports and writes
    // into the shell's startup file. It is the standalone installer's
    // ~/.openscience/bin whatever the data root is, so the line is one
    // `openscience uninstall` recognises.
    const f = await fixture({ files: { ".zshrc": "# mine\n" } })
    const status = await CliShim.status({ execPath: f.execPath, env: f.options.env, platform: "darwin" })
    const directory = path.join(Global.Path.home, ".openscience", "bin")
    expect(status).toMatchObject({
      home: Global.Path.home,
      directory,
      path: path.join(directory, "openscience"),
      line: `export PATH=${directory}:$PATH`,
    })
    await fs.writeFile(path.join(f.home, ".zshrc"), `# mine\n\n# openscience\n${status.line}\n`)
    await cleanShellConfig(path.join(f.home, ".zshrc"))
    expect(await f.file(".zshrc")).toBe("# mine\n")
  })

  test.each([
    ["bash", ".bashrc", (bin: string) => `export PATH=${bin}:$PATH`],
    ["fish", ".config/fish/config.fish", (bin: string) => `fish_add_path ${bin}`],
  ])("writes the installer's line for %s and never twice", async (shell, file, line) => {
    const f = await fixture({ shell, files: { [file]: "# mine\n" } })
    await CliShim.install(f.options)
    await CliShim.install(f.options)
    expect(await f.file(file)).toBe(`# mine\n\n# openscience\n${line(f.bin)}\n`)
    expect((await CliShim.status(f.options)).onPath).toBe(true)
  })

  test("recognises the installer's own line and adds nothing", async () => {
    const f = await fixture()
    const line = `export PATH=${f.bin}:$PATH`
    await fs.writeFile(path.join(f.home, ".zshrc"), `\n# openscience\n${line}\n`)
    await CliShim.install(f.options)
    expect(await f.file(".zshrc")).toBe(`\n# openscience\n${line}\n`)
  })

  test("adds no PATH line when the directory is already on PATH or a startup file mentions it", async () => {
    const onPath = await fixture({ files: { ".zshrc": "" }, env: { PATH: "/usr/bin" } })
    onPath.options.env = { ...onPath.options.env, PATH: `${onPath.bin}:/usr/bin` }
    await CliShim.install(onPath.options)
    expect(await onPath.file(".zshrc")).toBe("")
    expect((await CliShim.status(onPath.options)).onPath).toBe(true)

    const spelled = await fixture({ files: { ".zshrc": "path+=(~/.openscience/bin)\n" } })
    await CliShim.install(spelled.options)
    expect(await spelled.file(".zshrc")).toBe("path+=(~/.openscience/bin)\n")
    expect((await CliShim.status(spelled.options)).onPath).toBe(true)
  })

  test("creates the shell's startup file on an account that has none, once", async () => {
    const f = await fixture()
    const first = await CliShim.install(f.options)
    expect(await fs.readlink(f.link)).toBe(f.execPath)
    expect(first).toMatchObject({ onPath: true, config: path.join(f.home, ".zshrc") })
    expect(await f.file(".zshrc")).toBe(`# openscience\nexport PATH=${f.bin}:$PATH\n`)
    expect((await fs.readdir(f.home)).sort()).toEqual([".openscience", ".zshrc"])

    expect(await CliShim.install(f.options)).toEqual(first)
    expect(await f.file(".zshrc")).toBe(`# openscience\nexport PATH=${f.bin}:$PATH\n`)

    // `openscience uninstall` takes the block back out and leaves the file:
    // by then it may hold lines of the person's own.
    await fs.appendFile(path.join(f.home, ".zshrc"), "alias ll='ls -l'\n")
    expect(await uninstallPathLine(f.home, f.options.env)).toBe(path.join(f.home, ".zshrc"))
    expect(await f.file(".zshrc")).toBe("alias ll='ls -l'\n")
  })

  test("a startup file that held only the block is emptied, not deleted, by uninstall", async () => {
    const f = await fixture()
    await CliShim.install(f.options)
    expect(await uninstallPathLine(f.home, f.options.env)).toBe(path.join(f.home, ".zshrc"))
    expect(await f.file(".zshrc")).toBe("")
    expect((await CliShim.status(f.options)).onPath).toBe(false)
  })

  test("creates zsh's startup file where ZDOTDIR says zsh reads it", async () => {
    const f = await fixture()
    const zdot = path.join(f.home, ".config", "zsh")
    const options = { ...f.options, env: { ...f.options.env, ZDOTDIR: zdot } }
    const status = await CliShim.install(options)
    expect(status).toMatchObject({ onPath: true, config: path.join(zdot, ".zshrc") })
    expect(await f.file(".config/zsh/.zshrc")).toBe(`# openscience\nexport PATH=${f.bin}:$PATH\n`)
    expect(await fs.readdir(f.home)).not.toContain(".zshrc")

    expect(await uninstallPathLine(f.home, options.env)).toBe(path.join(zdot, ".zshrc"))
    expect(await f.file(".config/zsh/.zshrc")).toBe("")
  })

  test.each([
    ["darwin", ".bash_profile"],
    ["linux", ".bashrc"],
  ] as const)("creates the file a new bash terminal reads on %s", async (platform, file) => {
    const f = await fixture({ shell: "bash" })
    const options = { ...f.options, platform }
    const status = await CliShim.install(options)
    expect(status).toMatchObject({ onPath: true, config: path.join(f.home, file) })
    expect(await f.file(file)).toBe(`# openscience\nexport PATH=${f.bin}:$PATH\n`)
    expect((await fs.readdir(f.home)).sort()).toEqual([".openscience", file].sort())

    await CliShim.install(options)
    expect(await f.file(file)).toBe(`# openscience\nexport PATH=${f.bin}:$PATH\n`)

    expect(await uninstallPathLine(f.home, options.env)).toBe(path.join(f.home, file))
    expect(await f.file(file)).toBe("")
  })

  test("adds to the startup file bash already has instead of creating one that would shadow it", async () => {
    const f = await fixture({ shell: "bash", files: { ".profile": "# mine\n" } })
    await CliShim.install(f.options)
    expect(await f.file(".profile")).toBe(`# mine\n\n# openscience\nexport PATH=${f.bin}:$PATH\n`)
    expect((await fs.readdir(f.home)).sort()).toEqual([".openscience", ".profile"])
  })

  test("creates fish's configuration directory along with its file", async () => {
    const f = await fixture({ shell: "fish" })
    const status = await CliShim.install(f.options)
    expect(status).toMatchObject({
      onPath: true,
      line: `fish_add_path ${f.bin}`,
      config: path.join(f.home, ".config", "fish", "config.fish"),
    })
    expect(await f.file(".config/fish/config.fish")).toBe(`# openscience\nfish_add_path ${f.bin}\n`)

    await CliShim.install(f.options)
    expect(await f.file(".config/fish/config.fish")).toBe(`# openscience\nfish_add_path ${f.bin}\n`)

    // The installer and the app both spell fish's file from the home
    // directory, so uninstall finds it there whatever XDG_CONFIG_HOME says.
    const env = { ...f.options.env, XDG_CONFIG_HOME: path.join(f.home, "xdg") }
    expect(await uninstallPathLine(f.home, env)).toBe(path.join(f.home, ".config", "fish", "config.fish"))
    expect(await f.file(".config/fish/config.fish")).toBe("")
  })

  // Permission bits mean nothing on Windows, and root may write a read-only file.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips a startup file it may not write and reports that PATH still needs the line",
    async () => {
      const f = await fixture({ files: { ".zshrc": "# managed elsewhere\n" } })
      await fs.chmod(path.join(f.home, ".zshrc"), 0o444)
      const status = await CliShim.install(f.options)
      expect(await fs.readlink(f.link)).toBe(f.execPath)
      expect(status).toMatchObject({
        exists: true,
        current: true,
        onPath: false,
        line: `export PATH=${f.bin}:$PATH`,
        config: path.join(f.home, ".zshrc"),
      })
      expect(await f.file(".zshrc")).toBe("# managed elsewhere\n")
      expect((await fs.readdir(f.home)).sort()).toEqual([".openscience", ".zshrc"])
    },
  )

  test("a shell with no startup file of its own keeps the printed line", async () => {
    const f = await fixture({ shell: "sh" })
    const status = await CliShim.install(f.options)
    expect(await fs.readlink(f.link)).toBe(f.execPath)
    expect(status.onPath).toBe(false)
    expect(status.config).toBeUndefined()
    expect(status.line).toBe(`export PATH=${f.bin}:$PATH`)
    expect(await fs.readdir(f.home)).toEqual([".openscience"])
  })

  test("leaves a regular file alone", async () => {
    const f = await fixture({ files: { ".openscience/bin/openscience": "standalone binary", ".zshrc": "" } })
    const status = await CliShim.status(f.options)
    expect(status).toMatchObject({ exists: true, current: false, ours: false, installable: false })
    expect(status.reason).toContain("~/.openscience/bin/openscience is a file OpenScience did not create")
    await expect(CliShim.install(f.options)).rejects.toThrow("did not create")
    expect(await f.file(".openscience/bin/openscience")).toBe("standalone binary")
    expect(await f.file(".zshrc")).toBe("")
    expect(await CliShim.repair(f.options)).toBe(false)
    expect(await CliShim.remove(f.options)).toBe(false)
    expect(await f.file(".openscience/bin/openscience")).toBe("standalone binary")
  })

  test("leaves a link it did not create alone", async () => {
    const f = await fixture()
    await fs.mkdir(f.bin, { recursive: true })
    await fs.symlink("/usr/local/bin/openscience", f.link)
    const status = await CliShim.status(f.options)
    expect(status).toMatchObject({
      exists: true,
      target: "/usr/local/bin/openscience",
      ours: false,
      installable: false,
    })
    expect(status.reason).toContain("points at /usr/local/bin/openscience, which OpenScience did not create")
    await expect(CliShim.install(f.options)).rejects.toThrow("did not create")
    expect(await CliShim.repair(f.options)).toBe(false)
    expect(await CliShim.remove(f.options)).toBe(false)
    expect(await fs.readlink(f.link)).toBe("/usr/local/bin/openscience")
  })

  test("repairs its own link when the bundle moved, and creates nothing on its own", async () => {
    const f = await fixture()
    expect(await CliShim.repair(f.options)).toBe(false)
    expect(await fs.lstat(f.link).catch(() => undefined)).toBeUndefined()

    const gone = path.join(f.root, "Old", "OpenScience.app", "Contents", "Resources", "sidecar", "openscience")
    await fs.mkdir(f.bin, { recursive: true })
    await fs.symlink(gone, f.link)
    expect((await CliShim.status(f.options)).current).toBe(false)
    expect(await CliShim.repair(f.options)).toBe(true)
    expect(await fs.readlink(f.link)).toBe(f.execPath)
    expect((await CliShim.status(f.options)).current).toBe(true)
    expect(await CliShim.repair(f.options)).toBe(false)

    const moved = await bundle(f.root, "home/Applications")
    expect(await CliShim.repair({ ...f.options, execPath: moved })).toBe(true)
    expect(await fs.readlink(f.link)).toBe(moved)
  })

  test("only a lasting bundle may own the link", async () => {
    const f = await fixture()
    await fs.mkdir(f.bin, { recursive: true })
    await fs.symlink(path.join(f.root, "Gone.app", "Contents", "Resources", "sidecar", "openscience"), f.link)

    const terminal = { ...f.options, execPath: "/usr/local/bin/openscience" }
    expect((await CliShim.status(terminal)).reason).toBe(
      "Only the OpenScience desktop app can install its command-line tool.",
    )
    await expect(CliShim.install(terminal)).rejects.toThrow("Only the OpenScience desktop app")
    expect(await CliShim.repair(terminal)).toBe(false)

    const dev = {
      ...f.options,
      execPath: path.join(f.root, "dist", "openscience"),
      env: {
        ...f.options.env,
        OPENSCIENCE_DESKTOP_UPDATE_URL: "http://127.0.0.1:1/update",
        OPENSCIENCE_DESKTOP_UPDATE_TOKEN: "t",
      },
    }
    expect((await CliShim.status(dev)).reason).toContain("not inside an application bundle")
    await expect(CliShim.install(dev)).rejects.toThrow("not inside an application bundle")
    expect(await CliShim.repair(dev)).toBe(false)

    const appImage = {
      ...f.options,
      platform: "linux" as const,
      execPath: "/tmp/.mount_OpenScAb12cd/resources/sidecar/openscience",
      env: { ...f.options.env, APPIMAGE: "/home/me/OpenScience.AppImage" },
    }
    expect((await CliShim.status(appImage)).reason).toContain("AppImage runs from a temporary mount")
    await expect(CliShim.install(appImage)).rejects.toThrow("temporary mount")
    expect(await CliShim.repair(appImage)).toBe(false)

    const translocated = {
      ...f.options,
      execPath:
        "/private/var/folders/xy/T/AppTranslocation/1234/d/OpenScience.app/Contents/Resources/sidecar/openscience",
    }
    expect((await CliShim.status(translocated)).reason).toContain("quarantine copy")
    expect(await CliShim.repair(translocated)).toBe(false)

    const windows = { ...f.options, platform: "win32" as const }
    expect((await CliShim.status(windows)).reason).toContain("Windows")
    await expect(CliShim.install(windows)).rejects.toThrow("Windows")
    expect(await CliShim.repair(windows)).toBe(false)

    expect(await fs.readlink(f.link)).toContain("Gone.app")
  })

  test("removes only its own link", async () => {
    const f = await fixture({ files: { ".zshrc": "" } })
    expect(await CliShim.remove(f.options)).toBe(false)
    await CliShim.install(f.options)
    expect(await CliShim.remove(f.options)).toBe(true)
    expect(await fs.lstat(f.link).catch(() => undefined)).toBeUndefined()
    expect((await CliShim.status(f.options)).exists).toBe(false)
  })
})
