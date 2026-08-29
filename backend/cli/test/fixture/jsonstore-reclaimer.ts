import { JsonStore } from "../../src/util/jsonstore"

const [target, key, gate] = process.argv.slice(2)
if (!target || !key || !gate) throw new Error("jsonstore reclaimer fixture arguments are missing")

while (!(await Bun.file(gate).exists())) await Bun.sleep(5)
await JsonStore.update(target, (current) => ({ ...current, [key]: true }))
