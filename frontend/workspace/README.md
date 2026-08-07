## Usage

Dependencies for these templates are managed with [pnpm](https://pnpm.io) using `pnpm up -Lri`.

This is the reason you see a `pnpm-lock.yaml`. That said, any package manager will work. This file can safely be removed once you clone a template.

```bash
$ npm install # or pnpm install or yarn install
```

### Learn more on the [Solid Website](https://solidjs.com) and come chat with us on our [Discord](https://discord.com/invite/solidjs)

## Available Scripts

In the project directory, you can run:

### `npm run dev` or `npm start`

Runs the app in the development mode.<br>
Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

The page will reload if you make edits.<br>

### `npm run build`

Builds the app for production to the `dist` folder.<br>
It correctly bundles Solid in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.<br>
Your app is ready to be deployed!

## E2E Testing

`bun run test:e2e` is the safe default: it allocates fresh backend, Vite, and
model ports, creates a temp sandbox, seeds data, and never reuses an existing
port-3000 listener. `test:e2e:local` is an equivalent compatibility alias.
It also starts a loopback-only deterministic model so prompt/reply coverage never
uses developer credentials or an external inference service. Raw
`playwright test` is intentionally rejected because it cannot establish which
backend or checkout owns an existing listener.

```bash
bunx playwright install
bun run test:e2e
bun run test:e2e -- --grep "settings"
```

To test an already-running or packaged OpenScience server, opt in explicitly.
The external command requires `PLAYWRIGHT_BASE_URL`, does not start Vite, and
derives the SDK backend host/port from that URL unless separately overridden:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4112 bun run test:e2e:external
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4112 bun run test:e2e:packaged
```

Environment options for explicit external runs:

- `PLAYWRIGHT_BASE_URL` (required server URL)
- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (optional SDK backend override)

If the bundled browser cannot be installed on the host, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a compatible Chromium executable.

## Deployment

You can deploy the `dist` folder to any static host provider (netlify, surge, now, etc.)
