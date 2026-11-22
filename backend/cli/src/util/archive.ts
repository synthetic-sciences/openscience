import { $ } from "bun"
import path from "path"

export namespace Archive {
  export function windowsExtractCommand(zipPath: string, destDir: string) {
    // PowerShell single-quoted string literals escape apostrophes by doubling them.
    const quote = (value: string) => `'${path.resolve(value).replaceAll("'", "''")}'`
    // LiteralPath avoids treating brackets and wildcard characters as patterns.
    return `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destDir)} -Force`
  }

  export async function extractZip(zipPath: string, destDir: string) {
    if (process.platform === "win32") {
      await $`powershell -NoProfile -NonInteractive -Command ${windowsExtractCommand(zipPath, destDir)}`.quiet()
    } else {
      await $`unzip -o -q ${zipPath} -d ${destDir}`.quiet()
    }
  }
}
