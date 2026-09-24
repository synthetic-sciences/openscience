import { expect, test } from "bun:test"
import { ManagedEnvironments } from "../../../src/science/kernel/environment-manager"

// The layout conda-forge uses on Windows: python.exe at the prefix root, R
// under lib\R with the real binaries in bin\x64 and setuptools-style
// launchers in Scripts, and every DLL the interpreters and their packages
// load under Library\bin and Library\mingw-w64\bin. A process started without
// `conda activate` must put those directories on PATH itself (#704).
const prefix = "C:\\Users\\me\\.openscience\\conda\\envs\\r"

test("a Windows prefix launches R from its real x64 binary with the activation PATH and R_HOME", () => {
  const launch = ManagedEnvironments.launch("r", prefix, "win32")
  expect(launch.candidates).toEqual([
    `${prefix}\\lib\\R\\bin\\x64\\Rscript.exe`,
    `${prefix}\\lib\\R\\bin\\Rscript.exe`,
    `${prefix}\\Scripts\\Rscript.exe`,
  ])
  expect(launch.paths).toEqual([
    `${prefix}\\lib\\R\\bin\\x64`,
    prefix,
    `${prefix}\\Library\\mingw-w64\\bin`,
    `${prefix}\\Library\\usr\\bin`,
    `${prefix}\\Library\\bin`,
    `${prefix}\\Scripts`,
    `${prefix}\\bin`,
  ])
  expect(launch.env).toEqual({ CONDA_PREFIX: prefix, R_HOME: `${prefix}\\lib\\R` })
  expect(launch.delimiter).toBe(";")
})

test("a Windows prefix launches Python from its root with the same DLL directories and no R_HOME", () => {
  const python = "C:\\Users\\me\\.openscience\\conda\\envs\\python"
  const launch = ManagedEnvironments.launch("python", python, "win32")
  expect(launch.candidates).toEqual([`${python}\\python.exe`])
  expect(launch.paths[0]).toBe(python)
  expect(launch.paths).toContain(`${python}\\Library\\bin`)
  expect(launch.paths).toContain(`${python}\\Library\\mingw-w64\\bin`)
  expect(launch.paths).not.toContain(`${python}\\lib\\R\\bin\\x64`)
  expect(launch.env).toEqual({ CONDA_PREFIX: python })
})

test("a Unix prefix keeps only bin on PATH and derives nothing else", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const r = ManagedEnvironments.launch("r", "/home/me/.openscience/conda/envs/r", platform)
    expect(r.candidates).toEqual(["/home/me/.openscience/conda/envs/r/bin/Rscript"])
    expect(r.paths).toEqual(["/home/me/.openscience/conda/envs/r/bin"])
    expect(r.env).toEqual({ CONDA_PREFIX: "/home/me/.openscience/conda/envs/r" })
    expect(r.delimiter).toBe(":")
    const python = ManagedEnvironments.launch("python", "/home/me/.openscience/conda/envs/python", platform)
    expect(python.candidates).toEqual(["/home/me/.openscience/conda/envs/python/bin/python"])
  }
})
