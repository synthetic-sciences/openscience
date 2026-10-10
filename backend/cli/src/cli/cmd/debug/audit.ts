import { EOL } from "os"
import { CallAudit } from "../../../session/call-audit"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

export const AuditCommand = cmd({
  command: "audit <session>",
  describe: "show model-call identities recorded for a session and its workers",
  builder: (yargs) =>
    yargs.positional("session", {
      type: "string",
      demandOption: true,
      description: "session id",
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const report = await CallAudit.report(args.session as string)
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
    })
  },
})
