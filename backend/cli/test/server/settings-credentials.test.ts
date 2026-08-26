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
      'const invalidField = await app.request("/custom:lab", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { "api key": "secret" } }) })',
      'if (invalidField.status !== 400) throw new Error("invalid custom environment field was accepted")',
      'const unknown = await app.request("/not-a-service", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { api_key: "secret" } }) })',
      'if (unknown.status !== 400) throw new Error("unknown credential service was accepted")',
      'const custom = await app.request("/custom:lab", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Lab", fields: { access_token: "lab-secret" } }) })',
      "const customText = await custom.text()",
      'if (!custom.ok || customText.includes("lab-secret")) throw new Error("custom credential save leaked or failed")',
      'if (process.env.LAB_ACCESS_TOKEN !== "lab-secret") throw new Error("custom credential was not applied")',
      'const removed = await app.request("/custom:lab", { method: "DELETE" })',
      'if (!removed.ok || process.env.LAB_ACCESS_TOKEN !== undefined) throw new Error("custom credential was not removed live")',
    ].join("\n"),
  )

  try {
    const childEnv = { ...process.env }
    delete childEnv.GOOGLE_APPLICATION_CREDENTIALS
    delete childEnv.GOOGLE_APPLICATION_CREDENTIALS_JSON
    delete childEnv.GOOGLE_CLOUD_PROJECT
    const proc = Bun.spawn([process.execPath, runner], {
      env: {
        ...childEnv,
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

test("trusted Firecrawl and NVIDIA credentials resolve in-process without entering agent shells", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-trusted-credentials-"))
  const runner = path.join(root, "trusted.ts")
  const routes = new URL("../../src/server/routes/settings/credentials.ts", import.meta.url).href
  await Bun.write(
    runner,
    [
      `import { CredentialsRoutes, applyCredentialEnv, resolveCredentialFields } from ${JSON.stringify(routes)}`,
      `for (const key of ["FIRECRAWL_API_KEY", "NVIDIA_API_KEY", "NGC_API_KEY"]) delete process.env[key]`,
      `const app = CredentialsRoutes()`,
      `for (const [id, secret] of [["firecrawl", "fc-trusted"], ["nvidia", "nvapi-trusted"], ["nvidia_ngc", "ngc-trusted"]]) {`,
      `  const response = await app.request("/" + id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { api_key: secret } }) })`,
      `  if (!response.ok || (await response.text()).includes(secret)) throw new Error("trusted credential leaked or failed")`,
      `}`,
      `await applyCredentialEnv()`,
      `if (process.env.FIRECRAWL_API_KEY || process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY) throw new Error("trusted credential entered process env")`,
      `if ((await resolveCredentialFields("firecrawl"))?.api_key !== "fc-trusted") throw new Error("Firecrawl resolver failed")`,
      `if ((await resolveCredentialFields("nvidia"))?.api_key !== "nvapi-trusted") throw new Error("NVIDIA resolver failed")`,
      `if ((await resolveCredentialFields("nvidia_ngc"))?.api_key !== "ngc-trusted") throw new Error("NGC resolver failed")`,
      `if (await resolveCredentialFields("github")) throw new Error("untrusted service resolved through trusted API")`,
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
    if (exit !== 0) throw new Error(error)
    expect(exit).toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("GCP plaintext is atomic, sandbox-masked, and removed for corrupt or deleted ciphertext", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-gcp-credential-"))
  const runner = path.join(root, "gcp.ts")
  const routes = new URL("../../src/server/routes/settings/credentials.ts", import.meta.url).href
  const openscience = new URL("../../src/openscience/index.ts", import.meta.url).href
  await Bun.write(
    runner,
    [
      `import fs from "node:fs/promises"`,
      `import path from "node:path"`,
      `import { CredentialsRoutes, applyCredentialEnv } from ${JSON.stringify(routes)}`,
      `import { OpenScience } from ${JSON.stringify(openscience)}`,
      `const root = process.env.OPENSCIENCE_DATA_DIR`,
      `const plaintext = path.join(await fs.realpath(root), "gcp-service-account.json")`,
      `const app = CredentialsRoutes()`,
      `const invalid = await app.request("/gcp", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { service_account_json: "not-json" } }) })`,
      `if (invalid.status !== 400) throw new Error("invalid GCP JSON was accepted")`,
      `const first = JSON.stringify({ type: "service_account", project_id: "one", private_key: "secret-one" })`,
      `const saved = await app.request("/gcp", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { project_id: "one", service_account_json: first } }) })`,
      `if (!saved.ok || process.env.GOOGLE_APPLICATION_CREDENTIALS !== plaintext) throw new Error("GCP credential was not applied")`,
      `if (await fs.readFile(plaintext, "utf8") !== first) throw new Error("GCP plaintext mismatch")`,
      `if (process.platform !== "win32" && ((await fs.stat(plaintext)).mode & 0o777) !== 0o600) throw new Error("GCP plaintext permissions are not 0600")`,
      `if (!OpenScience.kernelSensitivePaths().includes(plaintext)) throw new Error("GCP plaintext is not sandbox masked")`,
      `const storePath = path.join(root, "credentials.json")`,
      `const store = JSON.parse(await fs.readFile(storePath, "utf8"))`,
      `store.gcp.fields.service_account_json = "invalid-ciphertext"`,
      `await fs.writeFile(storePath, JSON.stringify(store))`,
      `await applyCredentialEnv()`,
      `if (await Bun.file(plaintext).exists()) throw new Error("corrupt ciphertext left GCP plaintext behind")`,
      `if (process.env.GOOGLE_APPLICATION_CREDENTIALS !== undefined) throw new Error("corrupt ciphertext stayed in process.env")`,
      `const listed = await app.request("/")`,
      `const gcp = (await listed.json()).services.find((service) => service.id === "gcp")`,
      `if (gcp.connected || gcp.set_fields.includes("service_account_json") || !gcp.set_fields.includes("project_id")) throw new Error("corrupt ciphertext was reported as connected")`,
    ].join("\n"),
  )

  try {
    const childEnv = { ...process.env }
    delete childEnv.GOOGLE_APPLICATION_CREDENTIALS
    delete childEnv.GOOGLE_APPLICATION_CREDENTIALS_JSON
    delete childEnv.GOOGLE_CLOUD_PROJECT
    const proc = Bun.spawn([process.execPath, runner], {
      env: {
        ...childEnv,
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
    if (exit !== 0) throw new Error(`GCP credential child exited ${exit}: ${error || "no stderr"}`)
    expect(exit).toBe(0)
    expect(error).not.toContain("Error")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a second server drops rotated env and revokes an inherited child before its next spawn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-credential-revision-"))
  const mutate = path.join(root, "mutate.ts")
  const worker = path.join(root, "worker.ts")
  const ready = path.join(root, "ready")
  const routes = new URL("../../src/server/routes/settings/credentials.ts", import.meta.url).href
  const lifecycle = new URL("../../src/credentials/lifecycle.ts", import.meta.url).href
  const openscience = new URL("../../src/openscience/index.ts", import.meta.url).href
  await Bun.write(
    mutate,
    [
      `import { CredentialsRoutes } from ${JSON.stringify(routes)}`,
      `const app = CredentialsRoutes()`,
      `const remove = process.argv[2] === "remove"`,
      `const response = await app.request("/custom:lab", remove ? { method: "DELETE" } : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { access_token: "cross-process-secret" } }) })`,
      `if (!response.ok) throw new Error(await response.text())`,
    ].join("\n"),
  )
  await Bun.write(
    worker,
    [
      `import fs from "node:fs/promises"`,
      `import { spawn } from "node:child_process"`,
      `import { applyCredentialEnv } from ${JSON.stringify(routes)}`,
      `import { CredentialLifecycle } from ${JSON.stringify(lifecycle)}`,
      `import { OpenScience } from ${JSON.stringify(openscience)}`,
      `await CredentialLifecycle.ensureFresh()`,
      `await applyCredentialEnv()`,
      `if (process.env.LAB_ACCESS_TOKEN !== "cross-process-secret") throw new Error("worker did not load initial secret")`,
      `const inherited = await OpenScience.subprocessEnv(process.env)`,
      `const child = spawn(process.execPath, ["-e", "console.log(process.env.LAB_ACCESS_TOKEN || 'absent'); setInterval(() => {}, 1000)"], { env: inherited, stdio: ["ignore", "pipe", "pipe"] })`,
      `const first = await new Promise((resolve, reject) => { child.stdout.once("data", (data) => resolve(String(data).trim())); child.once("error", reject) })`,
      `if (first !== "cross-process-secret") throw new Error("real child did not inherit initial secret")`,
      `let revoked = false`,
      `CredentialLifecycle.onRevoke(async () => { revoked = true; child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)) })`,
      `CredentialLifecycle.watch(25)`,
      `await fs.writeFile(${JSON.stringify(ready)}, "ready")`,
      `for (let i = 0; i < 400 && !revoked; i++) await Bun.sleep(10)`,
      `await CredentialLifecycle.ensureFresh()`,
      `if (!revoked || (child.exitCode === null && child.signalCode === null)) throw new Error("inherited child was not revoked")`,
      `if (process.env.LAB_ACCESS_TOKEN !== undefined) throw new Error("removed secret stayed in worker process.env")`,
      `const next = Bun.spawn([process.execPath, "-e", "console.log(process.env.LAB_ACCESS_TOKEN || 'absent')"], { env: await OpenScience.subprocessEnv(process.env), stdout: "pipe", stderr: "pipe" })`,
      `const [code, output] = await Promise.all([next.exited, new Response(next.stdout).text()])`,
      `if (code !== 0 || output.trim() !== "absent") throw new Error("new child received the removed secret")`,
      `CredentialLifecycle.stopWatching()`,
    ].join("\n"),
  )

  const env = {
    ...process.env,
    OPENSCIENCE_DATA_DIR: root,
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
  const run = async (argv: string[]) => {
    const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" })
    const [exit, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (exit !== 0) throw new Error(error)
  }

  try {
    await run([process.execPath, mutate, "set"])
    const live = Bun.spawn([process.execPath, worker], { env, stdout: "pipe", stderr: "pipe" })
    for (let i = 0; i < 400 && !(await Bun.file(ready).exists()); i++) await Bun.sleep(10)
    expect(await Bun.file(ready).exists()).toBe(true)
    await run([process.execPath, mutate, "remove"])
    const [exit, error] = await Promise.all([live.exited, new Response(live.stderr).text()])
    if (exit !== 0) throw new Error(error)
    expect(exit).toBe(0)
    expect(error).not.toContain("Error")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
