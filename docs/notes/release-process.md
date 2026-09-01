# Release process

OpenScience ships as native binaries and an npm package
(`@synsci/openscience`). Releases are cut from `main` — never from a feature
branch.

## Cutting a release

1. Make sure the exact `main` commit you will release is green across the full
   CI workflow: Typecheck, Format, the Linux test suite, web/docs and landing
   builds, migration and runtime ownership checks on their platform matrices,
   launcher/release-script smoke tests, and workflow linting.
2. Trigger `test publish` from that exact `main` commit with packaged E2E and
   OS smokes enabled. Promotion is blocked until the exact npm candidate also
   installs and completes all five packaged scientific capability smoke
   lifecycles on Linux x64, Linux ARM64, and macOS ARM64. Each canary must
   report a ready exact-pack doctor state, semantic artifact validation, and
   evidence bound to the candidate's source SHA embedded in the compiled
   binary. A workflow environment variable is only a cross-check and must not
   be accepted as the source of release provenance.

   ```bash
   gh workflow run npm-test.yml --ref main \
     -f run_packaged_e2e=true \
     -f run_os_smoke=true \
     -f run_scientific_canary=true
   ```

   Before production, install that exact candidate in an isolated release
   operator root and run its bounded Modal smokes with the configured Modal
   account. This is the explicit paid-compute acknowledgement; archive the JSON
   report with the release evidence and do not substitute a source-tree run.

   ```bash
   openscience debug capability-canary --all --target modal \
     --acknowledge-remote-cost --timeout 900
   ```

3. After every candidate job succeeds, trigger the signed production `publish`
   workflow with a bump level:

   ```bash
   gh workflow run publish.yml --ref main -f bump=patch
   ```

   Production preflight independently queries the GitHub Actions API for that
   exact artifact-source SHA. It accepts only a completed `test publish` run
   whose packaged E2E, four native OS smokes, musl smoke, three scientific
   capability canaries, and `promote-test` job all succeeded. A run with either
   optional gate disabled, or with any required job skipped, cannot publish.
   Exact-version resumes remain bound to the immutable source marker in the
   existing draft release; the workflow rejects any mismatch before building.

   Stable publication has no unsigned macOS mode. Developer ID signing and
   notarization credentials are mandatory before the draft can be built. The
   Windows installer may still be published unsigned when both optional
   Windows signing secrets are absent; release notes disclose that separately.
   Ad-hoc-signed macOS development packages must never be attached to a stable
   update release.

   The next version is derived from the current npm `latest`, so there is no
   manual version editing in `package.json` and no risk of a tag collision.

4. The workflow then, in order: computes the version and opens a draft GitHub
   release → builds the platform binaries and signed/notarized macOS desktop
   installers → verifies the immutable ZIP and DMG on native Apple Silicon and
   Intel runners → upgrades a previous immutable signed stable app through the
   real helper/sidecar handoff, proves packaged main and runtime health and
   cleanup, and injects a safe health failure to prove rollback → uploads and
   verifies the checksum manifests → verifies the Linux x64 and ARM64 npm
   wrappers on native runners → publishes the CLI, SDK, plugin, and launcher
   packages to npm with provenance → attempts the Homebrew tap update → makes
   the release public only after every updater lifecycle and publication gate
   succeeds → records an npm deployment. If no older digest-bound signed stable
   updater ZIP exists for an architecture, the release fails closed.

   The publish job commits the generated package-version changes. It pushes that
   commit to `main` when the workflow identity may bypass branch protection;
   otherwise it opens a `release/vX.Y.Z` pull request. A green publish can
   therefore still require that small release PR to be merged.

## Conventions

- The repo bundles features into **patch** bumps unless a change is breaking —
  a feature release does not automatically imply a minor bump here.
- `bump` accepts `patch`, `minor`, or `major`. A reviewed resume or retry may
  provide an exact stable `version`; new releases normally derive the next
  stable version from npm `latest`. An exact-version resume must run from its
  immutable `v<version>` tag and may bind pre-existing desktop assets only with
  a reviewed digest manifest.
- The tag (`vX.Y.Z`) points at the exact tree that was published.

## Verifying a release

```bash
npm view @synsci/openscience version
npm view @synsci/sdk version
npm view @synsci/plugin version
npm view synsci version
gh release view vX.Y.Z --json isDraft,tagName,targetCommitish,assets
```

Confirm that the CLI, SDK, plugin, and launcher packages plus all 11 native npm
packages report the new version and expected dist-tags. Confirm that the GitHub
release is not a draft, the tag targets the release commit, and the assets include the
11 platform archives, `checksums.txt`, `desktop-checksums.txt`, two macOS DMGs,
two architecture-specific macOS updater ZIPs, one Windows EXE, and two Linux
AppImages: 20 release assets in total. Inspect the publish run for Homebrew,
launcher or Windows-signing warnings. macOS signing, notarization, immutable
asset verification, and both native updater lifecycles are fatal gates. Homebrew updates remain non-fatal
and may need owner follow-up. Publishing the `synsci` launcher is required in
both test and production releases; a launcher failure leaves the GitHub release
as a draft. Never bypass the updater lifecycle job or replace a stable macOS
asset with an ad-hoc-signed build.

See [verification.md](verification.md) for the local gates to run before you
push to `main`.

## Isolated npm test installs

The `test publish` workflow uses registry credentials and therefore runs only
from the protected `main` branch. Validate a candidate branch with the local
pack/build and browser gates first; after it lands on `main`, dispatch the test
workflow and require packaged E2E, operating-system smoke, and all three native
scientific-capability canary jobs to pass before starting production publish.

Every npm test build must use separate binary, config, data, cache, and state
roots. Use the exact prerelease version being validated; do not rely on a
moving dist-tag after installation.

```bash
export OPENSCIENCE_TEST_ROOT="/tmp/openscience-npm-2.0.2-test.N"
mkdir -p "$OPENSCIENCE_TEST_ROOT/home"
: >"$OPENSCIENCE_TEST_ROOT/npmrc"

export HOME="$OPENSCIENCE_TEST_ROOT/home"
export OPENSCIENCE_TEST_HOME="$HOME"
export OPENSCIENCE_CONFIG_DIR="$OPENSCIENCE_TEST_ROOT/config"
export OPENSCIENCE_DATA_DIR="$OPENSCIENCE_TEST_ROOT/data"
export XDG_CONFIG_HOME="$OPENSCIENCE_TEST_ROOT/xdg-config"
export XDG_DATA_HOME="$OPENSCIENCE_TEST_ROOT/xdg-data"
export XDG_CACHE_HOME="$OPENSCIENCE_TEST_ROOT/cache"
export XDG_STATE_HOME="$OPENSCIENCE_TEST_ROOT/state"
export NPM_CONFIG_PREFIX="$OPENSCIENCE_TEST_ROOT/npm"
export NPM_CONFIG_CACHE="$OPENSCIENCE_TEST_ROOT/npm-cache"
export NPM_CONFIG_USERCONFIG="$OPENSCIENCE_TEST_ROOT/npmrc"

npm install -g @synsci/openscience@2.0.2-test.N synsci@2.0.2-test.N
export PATH="$OPENSCIENCE_TEST_ROOT/npm/bin:$PATH"

openscience --version
synsci --version
openscience doctor
```

`OPENSCIENCE_CONFIG_DIR` is the authoritative OpenScience config directory,
and `OPENSCIENCE_DATA_DIR` is the authoritative application data directory.
When the config override is set, OpenScience does not also discover
`~/.openscience` or the normal XDG config directory. Config discovery is
dependency-passive: it does not create a package manifest, lockfile,
`node_modules`, or run dependency installation. A plugin named explicitly by
trusted config may still be installed when that plugin is actually loaded.

Removing the npm prefix does not remove the config or data roots. Retain them
for upgrade/uninstall validation, or remove the whole test root only after the
test record no longer needs it.
