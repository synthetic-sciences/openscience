import { EOL } from "node:os"
import { Storage } from "../../../storage/storage"
import { cmd } from "../cmd"

export const LegacyImportCommand = cmd({
  command: "legacy-import",
  describe: "list ambiguous legacy backups or explicitly restore selected pending records",
  builder: (yargs) =>
    yargs.option("restore", {
      type: "string",
      array: true,
      description: "pending record keys to restore, as kind/parent/id (or kind/id)",
    }),
  async handler(args) {
    const store = await Storage.research()
    if (args.restore?.length) await store.restoreLegacy(args.restore.map((key) => key.split("/")))
    process.stdout.write(JSON.stringify({ pending: await store.pendingLegacy() }, null, 2) + EOL)
  },
})
