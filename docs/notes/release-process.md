# Release process

OpenScience ships as native binaries and an npm package
(`@synsci/openscience`). Releases are cut from `main` — never from a feature
branch.

## Cutting a release

1. Make sure the exact `main` commit you will release is green across the full
   CI workflow: Typecheck, Format, the Linux test suite, web/docs and landing
   builds, migration and runtime ownership checks on their platform matrices,
   launcher/release-script smoke tests, and workflow linting.
2. Trigger the `publish` workflow with a bump level:

   ```bash
   gh workflow run publish.yml --ref main -f bump=patch   # or minor / major
   ```

   The next version is derived from the current npm `latest`, so there is no
   manual version editing in `package.json` and no risk of a tag collision.

3. The workflow then, in order: computes the version and opens a draft GitHub
   release → builds the platform binaries and uploads their checksum manifest →
   verifies the Linux x64 and ARM64 npm wrappers on native runners → publishes
   the CLI, SDK, plugin, and launcher packages to npm with provenance → attempts
   the Homebrew tap update → makes the release public only after required npm
   publishes succeed → records an npm deployment.

   The publish job commits the generated package-version changes. It pushes that
   commit to `main` when the workflow identity may bypass branch protection;
   otherwise it opens a `release/vX.Y.Z` pull request. A green publish can
   therefore still require that small release PR to be merged.

## Conventions

- The repo bundles features into **patch** bumps unless a change is breaking —
  a feature release does not automatically imply a minor bump here.
- `bump` accepts `patch`, `minor`, or `major`; a `version` input can override
  the computed value explicitly.
- The tag (`vX.Y.Z`) points at the exact tree that was published.

## Verifying a release

```bash
npm view @synsci/openscience version
npm view @synsci/sdk version
npm view @synsci/plugin version
gh release view vX.Y.Z --json isDraft,tagName,targetCommitish,assets
```

Confirm that the three npm packages report the new version, the GitHub release
is not a draft, the tag targets the release commit, and the assets include the
platform archives plus `checksums.txt`. Inspect the publish run for Homebrew or
launcher warnings; those updates are deliberately non-fatal and may need owner
follow-up.

See [verification.md](verification.md) for the local gates to run before you
push to `main`.

## Isolated npm test installs

The `test publish` workflow uses registry credentials and therefore runs only
from the protected `main` branch. Validate a candidate branch with the local
pack/build and browser gates first; after it lands on `main`, dispatch the test
workflow and require its packaged E2E and operating-system smoke jobs to pass
before starting the production publish.

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
