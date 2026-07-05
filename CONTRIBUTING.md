# Contributing to OpenScience

Thanks for your interest in contributing. These changes are the most likely to be merged:

- Bug fixes
- New LSPs and formatters
- Better model performance
- Support for new providers
- Fixes for environment-specific quirks
- Missing standard behavior
- Documentation improvements

Any UI or core product feature should go through a design discussion with the maintainers before you build it. If you are not sure whether a change would be accepted, ask in an issue or look for issues labeled [`help wanted`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3A%22help+wanted%22), [`good first issue`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3A%22good+first+issue%22), or [`bug`](https://github.com/synthetic-sciences/OpenScience/issues?q=is%3Aissue+state%3Aopen+label%3Abug).

## Development

You need Bun 1.3 or newer. Install dependencies and run the CLI from source:

```bash
bun install
bun dev
```

`bun dev` is the local equivalent of the built `openscience` command. It runs against the `backend/cli` directory by default. To run it elsewhere:

```bash
bun dev <directory>     # run in a specific directory
bun dev .               # run in the repo root
```

Common commands work the same in dev and in the built binary:

```bash
bun dev --help          # list commands
bun dev serve           # headless API server (port 4096 by default)
bun dev web             # start the server and open the workspace
```

### Building a standalone binary

```bash
./backend/cli/script/build.ts --single
./backend/cli/dist/@synsci/openscience-<platform>/bin/openscience
```

Replace `<platform>` with your platform, for example `darwin-arm64` or `linux-x64`.

### Where things live

- `backend/cli`: the CLI, server, and core logic.
- `frontend/workspace`: the workspace UI, written in SolidJS.
- `frontend/ui`: shared UI components and themes.
- `frontend/docs`: the documentation and share site.
- `frontend/landing`: the marketing site at openscience.sh.
- `tooling/plugin`: the source for `@synsci/plugin`.
- `tooling/sdk/js`: the TypeScript SDK.
- `tooling/launcher`: the `npx synsci` installer.

### Working on the workspace UI

Start the server, then run the UI dev server:

```bash
bun dev serve
bun run --cwd frontend/workspace dev
```

The UI dev server prints its local URL (usually http://localhost:5173). The API server must be running for full functionality.

If you change the API or SDK (for example `backend/cli/src/server/server.ts`), run `./tooling/repo/generate.ts` to regenerate the SDK and related files.

Please follow the [style guide](./AGENTS.md).

## Pull requests

### Link an issue

Open an issue before you open a pull request, and reference it with `Fixes #123` or `Closes #123`. For small fixes a short issue is enough. Pull requests without a linked issue may be closed.

### Keep it small

- Keep pull requests small and focused.
- Explain the problem and why your change fixes it.
- Check that the behavior does not already exist elsewhere before adding it.

### Show your work

For UI changes, include before-and-after screenshots or a short video. For logic changes, say how you verified the change: what you tested, and how a reviewer can reproduce the result.

### Write it yourself

Write short descriptions in your own words. Long generated walls of text in issues and pull requests may be ignored. If you cannot explain a change briefly, it may be too large.

### Pull request titles

Follow conventional commits, with an optional scope:

- `feat:` a new feature
- `fix:` a bug fix
- `docs:` documentation changes
- `chore:` maintenance and dependency updates
- `refactor:` refactoring with no behavior change
- `test:` tests
- `ci:` CI and release workflow changes

Examples: `docs: update contributing guide`, `fix: resolve crash on startup`, `feat(app): add dark mode`.

### Style

These are guidelines, not hard rules:

- Keep logic in one function unless splitting it adds real reuse.
- Avoid unnecessary destructuring.
- Avoid `else`.
- Prefer `.catch(...)` over `try`/`catch` where it reads well.
- Use precise types and avoid `any`.
- Prefer immutable values and avoid `let`.
- Choose concise, descriptive names.
- Use Bun helpers such as `Bun.file()` when they fit.

## Feature requests

For new functionality, start with a design conversation. Open an issue describing the problem, an optional proposed approach, and why it belongs in OpenScience. Wait for maintainer agreement before opening a feature pull request.
