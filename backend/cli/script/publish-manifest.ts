export interface WrapperSourcePackage {
  name: string
  optionalDependencies?: Record<string, string>
}

export interface WrapperPackageManifestOptions {
  source: WrapperSourcePackage
  version: string
  binaries: Record<string, string>
}

const retiredPublicCopy = [
  /\bAtlas\b/i,
  /managed compute/i,
  /cloud compute/i,
  /Ace\+/i,
  /150 credits/i,
  /research quota/i,
  /Synthetic Scientists access/i,
  /recurring monthly/i,
  /\$50 or \$200/i,
  /initialize-(?:atlas|research)-graph/i,
] as const

const unsafePublicCode = [
  {
    name: "recursive xattr",
    pattern: /\bxattr\b[\s\S]{0,120}["'`]-r[a-z]*\b/i,
  },
  {
    name: "recursive OpenScience data-root deletion",
    pattern: /\brmSync\s*\([\s\S]{0,160}(?:openscienceDir|\.openscience)[\s\S]{0,160}\brecursive\s*:\s*true/i,
  },
] as const

/** Fail packaging when an npm-visible text file reintroduces a retired public
 * contract or destructive launcher behavior. Internal compatibility
 * identifiers are not scanned; callers pass only files npm users can read or
 * execute. */
export function assertPublicPackageSurface(files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const match = retiredPublicCopy.find((pattern) => pattern.test(content))
    if (match) throw new Error(`${file} contains retired public copy matching ${match}`)
    const unsafe = unsafePublicCode.find((entry) => entry.pattern.test(content))
    if (unsafe) throw new Error(`${file} contains unsafe public package code: ${unsafe.name}`)
  }
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
