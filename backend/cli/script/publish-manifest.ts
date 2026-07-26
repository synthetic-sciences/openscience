export interface WrapperSourcePackage {
  name: string
  optionalDependencies?: Record<string, string>
}

export interface WrapperPackageManifestOptions {
  source: WrapperSourcePackage
  version: string
  binaries: Record<string, string>
}

/** Build the npm wrapper manifest without discarding optional companions from
 * the source package. Platform binaries are added alongside packages such as
 * @synsci/atlas; they are not a replacement for them. */
export function createWrapperPackageManifest(options: WrapperPackageManifestOptions) {
  return {
    name: options.source.name,
    bin: {
      openscience: "./bin/openscience",
    },
    scripts: {
      // Best-effort: clears a stale global @synsci/cli whose `openscience`
      // bin link would make npm refuse the install (EEXIST); never fails.
      preinstall: "node ./preinstall.mjs || exit 0",
      postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
    },
    version: options.version,
    // npm provenance refuses packages whose repository.url doesn't match
    // the repo the workflow ran from (case-sensitive).
    repository: {
      type: "git",
      url: "git+https://github.com/synthetic-sciences/openscience.git",
    },
    optionalDependencies: {
      ...(options.source.optionalDependencies ?? {}),
      ...options.binaries,
    },
  }
}
