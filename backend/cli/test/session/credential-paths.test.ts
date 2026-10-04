import { expect, spyOn, test } from "bun:test"
import { OpenScience } from "../../src/openscience"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { File } from "../../src/file"
import { tmpdir } from "../fixture/fixture"

test("in-process file access refuses the credential paths the sandbox masks, even inside a grant", async () => {
  await using project = await tmpdir({ git: true })
  // Point the masked list at a temporary home; the real one stays untouched.
  await using home = await tmpdir()
  const masked = spyOn(OpenScience, "kernelSensitivePaths").mockReturnValue([path.join(home.path, ".ssh")])
  try {
    const key = path.join(home.path, ".ssh", "id_fixture")
    const notes = path.join(home.path, "notes.txt")
    await Bun.write(key, "fixture")
    await Bun.write(notes, "visible")
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionFilesystem.grant({
          sessionID: session.id,
          path: home.path,
          access: "read",
          scope: "session",
          source: "api",
        })
        expect(await SessionFilesystem.isCredentialPath(key)).toBe(true)
        expect(await SessionFilesystem.isCredentialPath(notes)).toBe(false)

        await expect(
          SessionFilesystem.authorize({ sessionID: session.id, path: key, access: "read" }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect((await SessionFilesystem.authorize({ sessionID: session.id, path: notes, access: "read" })).path).toBe(
          notes,
        )

        await expect(File.read(key, { sessionID: session.id })).rejects.toThrow()
        expect((await File.read(notes, { sessionID: session.id })).content).toBe("visible")
        await Session.remove(session.id)
      },
    })
  } finally {
    masked.mockRestore()
  }
})
