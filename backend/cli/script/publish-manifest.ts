export interface WrapperSourcePackage {
  name: string
  optionalDependencies?: Record<string, string>
}

export interface WrapperPackageManifestOptions {
  source: WrapperSourcePackage
  version: string
  binaries: Record<string, string>
}

/** Build the npm wrapper manifest without discarding declared optional
 * companions. Platform binaries are added alongside them. */
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
      // Advisory only. The Node wrapper resolves and validates the native
      // package at launch, so blocked or failed lifecycle scripts must not
      // turn an otherwise usable package into a failed install.
      postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs || exit 0",
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
