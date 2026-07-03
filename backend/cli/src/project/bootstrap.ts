import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Skill } from "../skill/skill"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { RSILifecycle } from "../session/rsi/lifecycle"
import { RLMArtifacts } from "../session/rlm/artifacts"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()

  // RSI lifecycle: archive unused learned skills, log high performers
  RSILifecycle.startupCheck().catch(() => {})
  // RLM artifacts: remove 7-day old artifacts
  RLMArtifacts.cleanup().catch(() => {})

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })

  // Hot-reload the skill registry when a SKILL.md changes on disk (external
  // edits surface via the watcher when OPENSCIENCE_EXPERIMENTAL_FILEWATCHER=1;
  // in-app authoring self-invalidates through Skill.writeUser).
  Bus.subscribe(FileWatcher.Event.Updated, async (payload) => {
    if (payload.properties.file.endsWith("SKILL.md")) {
      await Skill.invalidate().catch(() => {})
    }
  })
}
