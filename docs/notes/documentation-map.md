# Documentation source map

This is the maintainer index for the public documentation refresh. The audit starts from main commit `7dabbf08` (2026-09-05), then follows the current source on this branch. See [repository-index.md](repository-index.md) for the repository inventory.

Public guides explain supported user workflows. Existing architecture, contributor, release, and extension notes remain the reference for implementation work. Public documentation should not copy internal service composition into setup instructions.

## Source-to-guide coverage

All page paths below are relative to `frontend/docs/src/content/openscience/`.

| Guide                    | Source of behavior                                                                                                                                          | Verification                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `index`, `quickstart`    | `frontend/workspace/src/components/settings/Models.tsx`; `backend/cli/src/cli/onboard.ts`; `backend/cli/src/cli/cmd/web.ts`                                 | Desktop, browser, and terminal entrypoints; account-optional model access.                                                       |
| `installation`           | `install`; `tooling/launcher/bin/synsci.mjs`; `frontend/landing/src/pages/Download.tsx`; `backend/cli/src/cli/cmd/upgrade.ts` and `uninstall.ts`            | Current downloads, update commands, preserved-data uninstall default.                                                            |
| `workspace`              | `frontend/workspace/src/pages/session.tsx`; `session-sidebar-action.tsx`; `backend/cli/src/cli/cmd/web.ts`                                                  | Files, Terminal, Compute, queueing, undo, printed server URL.                                                                    |
| `models`                 | `backend/cli/src/cli/cmd/auth.ts` and `models.ts`; `frontend/workspace/src/components/settings/Models.tsx`                                                  | Exact model IDs, provider sign-in, environment keys, available reasoning controls.                                               |
| `ace`                    | `backend/cli/src/cli/cmd/connect.ts` and `billing.ts`; `frontend/workspace/src/components/settings/ManagedInference.tsx` and `General.tsx`                  | Funding workspace, sign-in, shared connections, reload authorization.                                                            |
| `pricing`                | `frontend/landing/src/components/Ace.tsx`; `backend/cli/src/openscience/ace-contract.ts`; `frontend/workspace/src/components/settings/ManagedInference.tsx` | $0 authorization, $20 below $5, separate processing fee, no subscription. Variable rates remain in the model/account disclosure. |
| `local-models`           | `backend/cli/src/provider/local.ts`; `backend/cli/src/cli/cmd/local.ts`; `frontend/workspace/src/components/settings/LocalModels.tsx`                       | Discovery, tool support, context settings, SSH, endpoint removal; existing provider/local tests.                                 |
| `custom-providers`       | `backend/cli/src/config/config.ts`; `backend/cli/src/provider/provider.ts`                                                                                  | Provider schema, explicit capabilities, deadlines; configuration-example validation.                                             |
| `literature-review`      | `backend/cli/src/science/connectors/literature/`; `backend/cli/skills/research/`                                                                            | A requested workflow with explicit deliverables, rather than promised automatic exhaustive coverage.                             |
| `data-analysis`          | `frontend/workspace/src/components/settings/Compute.tsx`; bundled analysis skills                                                                           | Inputs, methods, script and output review; prerequisites stated.                                                                 |
| `reproduction`           | Bundled research and training skills; `frontend/workspace/src/components/settings/Compute.tsx`                                                              | Exact versus partial reproduction, budget, pilot, evidence and limitations.                                                      |
| `writing`                | `backend/cli/skills/` writing and visualization entries                                                                                                     | Requested document outputs and compilation checks; no unsupported format guarantees.                                             |
| `agents`                 | `backend/cli/src/agent/agent.ts`; `backend/cli/src/cli/cmd/agent.ts`; `frontend/workspace/src/components/prompt-capabilities.ts` and `research-access.ts`   | Research/plan distinction, Normal/Ultra, Off/Auto/High, current independence and approval labels.                                |
| `sessions`               | `backend/cli/src/cli/cmd/run.ts`, `session.ts`, `export.ts`, `import.ts`                                                                                    | Current flags, continuation, file attachment, export scope, run-policy tests.                                                    |
| `files`                  | `frontend/workspace/src/atlas/FilePreview.tsx`; `frontend/workspace/src/components/settings/Storage.tsx`; `frontend/workspace/src/pages/session-undo.ts`    | Project files versus scratch, storage moves, backups, undo limitations.                                                          |
| `compute`                | `frontend/workspace/src/components/settings/Compute.tsx`; project Compute view                                                                              | Local setup, own remote resources, connection checks, job/output review.                                                         |
| `scientific-tools`       | `frontend/workspace/src/components/settings/ScientificTools.tsx` and `scientific-tools-state.ts`; `backend/cli/src/science/capability/manifests/`           | Actual visible statuses, prerequisites, experimental limitations.                                                                |
| `skills`                 | `backend/cli/src/cli/cmd/skill.ts`; `backend/cli/src/skill/skill.ts`                                                                                        | Install/list/show/new/edit/validate/entries/remove, project folders, disabled skills.                                            |
| `skill-library`          | Every `backend/cli/skills/**/SKILL.md`                                                                                                                      | Generated full directory; freshness check.                                                                                       |
| `databases`              | `backend/cli/src/science/connectors/index.ts` and its registered connectors                                                                                 | Generated complete catalog; no live source availability guarantee.                                                               |
| `connectors`             | `backend/cli/src/cli/cmd/mcp.ts`; `backend/cli/src/config/config.ts`; `frontend/workspace/src/components/settings/Connectors.tsx`                           | Remote/local shapes, enabled state, OAuth, removal; schema validation.                                                           |
| `instructions`           | `backend/cli/src/session/instruction.ts`                                                                                                                    | AGENTS.md, compatible instruction files, configured protocols, global scope.                                                     |
| `configuration`          | `backend/cli/src/config/config.ts`; `backend/cli/src/global/index.ts`                                                                                       | Actual locations and fields; every JSON example parsed by Config.Info.                                                           |
| `slash-commands`         | `backend/cli/src/command/index.ts`; `frontend/workspace/src/components/prompt-slash.ts`                                                                     | Current controls, contextual/skill entries, command files and arguments.                                                         |
| `permissions`            | `frontend/workspace/src/components/research-access.ts`; `backend/cli/src/config/config.ts`                                                                  | Current approval labels and narrow action rules; no absolute safety claims.                                                      |
| `commands`               | `backend/cli/src/index.ts` and registered `src/cli/cmd/` definitions                                                                                        | Actual --help; retired commands removed, account/local commands added.                                                           |
| `automation`             | `backend/cli/src/cli/cmd/run.ts`; `backend/cli/src/cli/run-events.ts`; `backend/cli/test/cli/run-*.test.ts`                                                 | JSON event schema and exit codes; early failures need not emit a done event.                                                     |
| `extensions`             | `tooling/sdk/js/src/v2/`; `tooling/plugin/src/`; `backend/cli/src/cli/cmd/acp.ts`; `docs/notes/writing-a-plugin.md`                                         | Versioned SDK methods, supported ACP flags, plugin configuration.                                                                |
| `troubleshooting`, `faq` | The sources above and their reported UI errors                                                                                                              | Recovery steps refer to observed settings and distinguish access, setup, and payment failures.                                   |

## Audited corrections

- Replace the outdated account-free-only onboarding with the three current access choices.
- Remove outdated installation workarounds and unsupported command references.
- Replace fixed model examples and historical pricing tables with exact-ID discovery and current rate disclosures.
- Explain that model access changes do not cancel automatic Wallet reloads.
- Replace the stale skill and database counts with generated directories.
- Correct the claim that the workspace lacks a terminal.
- Document actual Ollama context settings and the existing SSH connection form.
- Use the current approval and delegation labels.
- Remove promises that all activity remains offline or that sign-in is a full research backup.
- Preserve old documentation routes while moving their useful guidance into the appropriate user pages.

## Documentation behavior

`frontend/docs/src/navigation.ts` owns route aliases, page-and-section links, and headings. Unit tests cover these functions; browser tests exercise the rendered production application, including every page.

`frontend/docs/script/check.ts` treats the documentation as input data: it checks navigation coverage, internal links, actual anchors, repository file targets, and JSON against the configuration and run-event schemas. It does not test component source strings.

`script/catalog.ts` generates the skill and database directories. `script/export.ts` generates `llms.txt` and `llms-full.txt` during builds.

Fast CI runs the full checks with backend dependencies installed. The hosting build needs only the documentation package; it generates exports and bundles the content without loading backend modules.

## External references reviewed

- [Claude Code overview](https://code.claude.com/docs/en/overview): organize entrypoints around a first task and link to deeper workflow and reference guides.
- [Cursor documentation](https://cursor.com/docs): make setup, models/pricing, customization, and integrations easy to find.
- [Ollama quickstart](https://docs.ollama.com/quickstart): keep installation-to-first-response steps short.
- [Ollama API compatibility](https://docs.ollama.com/api/openai-compatibility) and [LM Studio compatibility](https://lmstudio.ai/docs/developer/openai-compat): verify local endpoint setup against the runtime's own documentation.

These references inform structure and external setup details. Product claims come from OpenScience's code and current public product terms.

## Maintenance rule

When a user-visible behavior changes, update its guide and this map if ownership moves. Regenerate the directories after changing bundled skills or registered databases. Run `bun run test:docs`, the docs typecheck/build, and browser tests for navigation or rendering changes.

Paid model calls, checkout, and third-party compute are not exercised by documentation checks. Existing tests and schema checks establish local contracts; service availability and account-specific terms must still be checked in the relevant account.
