import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("credential writes are encrypted, owner-only, and safe across processes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-credentials-"))
  const runner = path.join(root, "save.ts")
  const routes = new URL("../../src/server/routes/settings/credentials.ts", import.meta.url).href
  await Bun.write(
    runner,
    [
      "import { CredentialsRoutes } from " + JSON.stringify(routes),
      "const id = process.argv[2]",
      "const secret = process.argv[3]",
      'const response = await CredentialsRoutes().request("/" + id, {',
      '  method: "PUT",',
      '  headers: { "content-type": "application/json" },',
      "  body: JSON.stringify({ label: id, fields: { api_key: secret } }),",
      "})",
      "const text = await response.text()",
      "if (!response.ok) throw new Error(text)",
      'if (text.includes(secret)) throw new Error("credential response exposed the saved value")',
    ].join("\n"),
  )

  try {
    const processes = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn([process.execPath, runner, "custom:service-" + index, "credential-secret-" + index], {
        env: {
          ...process.env,
          OPENSCIENCE_DATA_DIR: root,
          OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
          OPENSCIENCE_TEST_HOME: path.join(root, "home"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(
      processes.map(async (proc) => ({
        exit: await proc.exited,
        error: await new Response(proc.stderr).text(),
      })),
    )
    expect(results.filter((result) => result.exit !== 0)).toEqual([])

    const store = await Bun.file(path.join(root, "credentials.json")).text()
    expect(store).not.toContain("credential-secret-")
    expect(Object.keys(JSON.parse(store))).toHaveLength(8)
    expect((await Bun.file(path.join(root, "credentials.key")).arrayBuffer()).byteLength).toBe(32)
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(root, "credentials.json"))).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.join(root, "credentials.key"))).mode & 0o777).toBe(0o600)
    }
    const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("credential catalog is categorized and injects integration and compute environments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-credential-catalog-"))
  const runner = path.join(root, "catalog.ts")
  const routes = new URL("../../src/server/routes/settings/credentials.ts", import.meta.url).href
  await Bun.write(
    runner,
    [
      "import { CredentialsRoutes } from " + JSON.stringify(routes),
      'for (const key of ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_DEFAULT_REGION"]) delete process.env[key]',
      "const app = CredentialsRoutes()",
      'const catalog = await app.request("/")',
      "const services = (await catalog.json()).services",
      'const integration = services.filter((service) => service.category === "integration").map((service) => service.id)',
      'const compute = services.filter((service) => service.category === "compute").map((service) => service.id)',
      'for (const id of ["github", "openalex", "huggingface", "tinker", "wandb", "pinecone", "langsmith"]) {',
      '  if (!integration.includes(id)) throw new Error("missing integration " + id)',
      "}",
      'for (const id of ["aws", "gcp", "azure", "nvidia"]) {',
      '  if (!compute.includes(id)) throw new Error("missing compute credential " + id)',
      "}",
      'await app.request("/huggingface", {',
      '  method: "PUT",',
      '  headers: { "content-type": "application/json" },',
      '  body: JSON.stringify({ fields: { api_key: "hf_catalog_test" } }),',
      "})",
      'await app.request("/aws", {',
      '  method: "PUT",',
      '  headers: { "content-type": "application/json" },',
      '  body: JSON.stringify({ fields: { access_key_id: "AKIATEST", secret_access_key: "aws-secret", region: "us-west-2" } }),',
      "})",
      'if (process.env.HF_TOKEN !== "hf_catalog_test") throw new Error("Hugging Face token was not injected")',
      'if (process.env.HUGGING_FACE_HUB_TOKEN !== "hf_catalog_test") throw new Error("Hugging Face alias was not injected")',
      'if (process.env.AWS_ACCESS_KEY_ID !== "AKIATEST") throw new Error("AWS access key was not injected")',
      'if (process.env.AWS_REGION !== "us-west-2") throw new Error("AWS region was not injected")',
    ].join("\n"),
  )

  try {
    const proc = Bun.spawn([process.execPath, runner], {
      env: {
        ...process.env,
        OPENSCIENCE_DATA_DIR: root,
        OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
        OPENSCIENCE_TEST_HOME: path.join(root, "home"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(exit).toBe(0)
    expect(error).not.toContain("Error")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
