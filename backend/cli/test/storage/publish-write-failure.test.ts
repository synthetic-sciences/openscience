import { expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// A record that cannot be staged has to say why. On Windows the first writer
// has failed with an error that carried no code or path, and "Error at write
// (unknown)" was all the person sending a prompt saw.
test("a record that cannot be written fails with the system's reason, and an ordinary write still lands", async () => {
  const blocked = path.join(Global.Path.data, "storage", "write_failure_probe")
  await fs.mkdir(path.dirname(blocked), { recursive: true })
  // A file where the record's directory should be: no writer can stage under it.
  await fs.writeFile(blocked, "not a directory")
  try {
    const failure = await Storage.write(["write_failure_probe", "record"], { ok: true }).then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.code).toMatch(/^E[A-Z]+$/)
    expect(String(failure?.message)).toContain("write_failure_probe")
  } finally {
    await fs.rm(blocked, { force: true })
  }

  await Storage.write(["write_failure_probe", "record"], { ok: true })
  expect(await Storage.read<{ ok: boolean }>(["write_failure_probe", "record"])).toEqual({ ok: true })
  await Storage.remove(["write_failure_probe", "record"])
  await fs.rm(blocked, { recursive: true, force: true })
})
