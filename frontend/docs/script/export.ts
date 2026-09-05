import path from "node:path"
import config from "../src/content/openscience/docs.json"

const output = path.resolve(import.meta.dir, "../public")
const directory = path.resolve(import.meta.dir, "../src/content/openscience")
const index = [
  "# OpenScience documentation",
  "",
  "> Guides for installation, model access, Ace pricing, scientific research, and customization.",
  "",
  "Full text: https://openscience.sh/docs/llms-full.txt",
  "",
]
const full = ["# OpenScience documentation", "", "Source: https://openscience.sh/docs/", ""]
for (const tab of config.navigation.tabs) {
  for (const group of tab.groups) {
    index.push("## " + group.group, "")
    for (const name of group.pages) {
      const raw = await Bun.file(path.join(directory, name + ".mdx")).text()
      const title = raw.match(/^title: "(.+)"$/m)?.[1] ?? name
      const description = raw.match(/^description: "(.+)"$/m)?.[1] ?? ""
      const url = "https://openscience.sh/docs/#/openscience/" + name
      const body = raw
        .replace(/^---\n[\s\S]*?\n---\n?/, "")
        .replace(/<Card\s+title="([^"]+)"\s+href="([^"]+)">\s*([\s\S]*?)\s*<\/Card>/g, "[$1]($2): $3")
        .replace(/<\/?(?:Columns|CardGroup)\b[^>]*>/g, "")
        .replace(/\]\(\/openscience\/([^)]*)\)/g, "](https://openscience.sh/docs/#/openscience/$1)")
      index.push("- [" + title + "](" + url + "): " + description)
      full.push("# " + title, "", description, "", "URL: " + url, "", body.trim(), "")
    }
    index.push("")
  }
}
await Bun.write(path.join(output, "llms.txt"), index.join("\n"))
await Bun.write(path.join(output, "llms-full.txt"), full.join("\n"))
console.log("Generated plain-text documentation exports.")
