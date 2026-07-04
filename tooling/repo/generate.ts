#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./tooling/sdk/js/script/build.ts`

await $`bun dev generate > ../../tooling/sdk/openapi.json`.cwd("backend/cli")

await $`./tooling/repo/format.ts`
