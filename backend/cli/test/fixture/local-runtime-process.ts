import fs from "node:fs"

const [environment, pidfile] = process.argv.slice(2)
if (!environment || !pidfile) throw new Error("local runtime fixture requires environment and pid files")

fs.writeFileSync(environment, JSON.stringify(process.env), { encoding: "utf8", mode: 0o600 })
fs.writeFileSync(pidfile, String(process.pid), { encoding: "utf8", mode: 0o600 })

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0))
setInterval(() => {}, 1_000)
