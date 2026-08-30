import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const python = Bun.which("python3") ?? Bun.which("python")
const root = path.resolve(import.meta.dir, "../..")
const schematic = path.join(root, "skills/visualization/scientific-schematics/scripts")
const slides = path.join(root, "skills/writing/scientific-slides/scripts")
const image = path.join(root, "skills/llm-tools/generate-image/scripts/generate_image.py")

async function environment(dir: string, byok = "") {
  return {
    ...process.env,
    XDG_CONFIG_HOME: dir,
    OPENROUTER_API_KEY: byok,
    OPENROUTER_BASE_URL: byok ? "https://openrouter.ai/api/v1" : "",
  }
}

test("standalone Nano Banana helpers automatically use a connected BYOK key", async () => {
  if (!python) return
  await using tmp = await tmpdir()
  const env = await environment(tmp.path, "sk-or-test-byok")
  env.OPENROUTER_BASE_URL = "https://app.syntheticsciences.ai/api/llm/proxy/openrouter/v1"
  const code = `
import importlib.util, json

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

schematic = load("schematic", ${JSON.stringify(path.join(schematic, "generate_schematic_ai.py"))})
slides = load("slides", ${JSON.stringify(path.join(slides, "generate_slide_image_ai.py"))})
image = load("image", ${JSON.stringify(image)})
a = schematic.ScientificSchematicGenerator()
b = slides.SlideImageGenerator()
print(json.dumps({
    "schematic": [a.api_key, a.base_url, a.image_model],
    "slides": [b.api_key, b.base_url, b.image_model],
    "image": [image.byok_key("sk-or-test-byok"), image.byok_base_url()],
}))
`
  const proc = Bun.spawn([python, "-c", code], { env, stdout: "pipe", stderr: "pipe" })
  const output = await new Response(proc.stdout).text()
  const error = await new Response(proc.stderr).text()
  expect(await proc.exited).toBe(0)
  expect(error).toBe("")
  expect(JSON.parse(output)).toEqual({
    schematic: ["sk-or-test-byok", "https://openrouter.ai/api/v1", "google/gemini-3-pro-image"],
    slides: ["sk-or-test-byok", "https://openrouter.ai/api/v1", "google/gemini-3-pro-image"],
    image: ["sk-or-test-byok", "https://openrouter.ai/api/v1"],
  })
})

test("standalone Nano Banana helpers never expose a retired product token", async () => {
  if (!python) return
  await using tmp = await tmpdir()
  const env = await environment(tmp.path, "thk_test_managed")
  env.OPENROUTER_BASE_URL = "https://app.syntheticsciences.ai/api/llm/proxy/openrouter/v1"
  const code = `
import importlib.util, json

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

modules = [
    load("schematic", ${JSON.stringify(path.join(schematic, "generate_schematic_ai.py"))}),
    load("slides", ${JSON.stringify(path.join(slides, "generate_slide_image_ai.py"))}),
]
errors = []
for module, name in [(modules[0], "ScientificSchematicGenerator"), (modules[1], "SlideImageGenerator")]:
    try:
        getattr(module, name)()
    except ValueError as error:
        errors.append(str(error))
print(json.dumps(errors))
`
  const proc = Bun.spawn([python, "-c", code], { env, stdout: "pipe", stderr: "pipe" })
  const output = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  const errors = JSON.parse(output) as string[]
  expect(errors).toHaveLength(2)
  expect(errors.every((error) => error.includes("OpenRouter BYOK is not connected"))).toBe(true)
  expect(errors.every((error) => error.includes("connect Gemini or OpenRouter"))).toBe(true)
  expect(errors.every((error) => error.includes("native generate_image tool"))).toBe(true)
})

test("standalone wrappers direct OpenScience sessions to the native user-provider tool", async () => {
  if (!python) return
  await using tmp = await tmpdir()
  const env = await environment(tmp.path, "thk_test_managed")
  env.OPENROUTER_BASE_URL = "https://app.syntheticsciences.ai/api/llm/proxy/openrouter/v1"
  const entries: Array<[string, string[]]> = [
    [path.join(schematic, "generate_schematic.py"), ["--iterations", "1"]],
    [path.join(slides, "generate_slide_image.py"), ["--iterations", "1"]],
    [image, []],
  ]

  for (const [entry, args] of entries) {
    const proc = Bun.spawn([python, entry, "credential probe", "-o", path.join(tmp.path, "probe.png"), ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(proc.stdout).text()
    const error = await new Response(proc.stderr).text()
    const text = `${output}\n${error}`
    expect(await proc.exited).toBe(1)
    expect(text).toContain("OpenRouter BYOK is not connected")
    expect(text).toContain("connect Gemini or OpenRouter")
    expect(text).toContain("generate_image")
    expect(text).not.toContain("OPENROUTER_API_KEY environment variable not set")
  }
})

test("the image skill requires the native user-provider route", async () => {
  const skill = await Bun.file(path.join(root, "skills/llm-tools/generate-image/SKILL.md")).text()
  const core = await Bun.file(path.join(root, "src/session/prompt/core.txt")).text()
  const registry = await Bun.file(path.join(root, "src/tool/registry.ts")).text()

  expect(skill).toContain("always call the native `generate_image` tool")
  expect(skill).toContain("connected Gemini or OpenRouter account")
  expect(core).toContain("connected Gemini or OpenRouter account")
  expect(registry).toContain("GenerateImageTool")
})
