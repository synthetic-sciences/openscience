# Local lab plugin

A small package using only `@synsci/plugin`. It contributes the `local-lab`
scientific source and a `local_lab_summary` tool. The source contains two offline
calibration records; the tool returns their count and arithmetic mean with a CSV
attachment. No model, network service, credentials, or compute account is needed
to test the package.

## Develop and test

From an OpenScience development checkout with dependencies installed:

```bash
cd examples/local-lab-plugin
bun run setup
bun test
```

Setup links this checkout's actual plugin package into the example's local
`node_modules`; it installs nothing and changes no global package registrations.
These contribution APIs must be released before a standalone
package can depend on their published version. When copying the example out of
the repository, install and pin the exact compatible published
`@synsci/plugin` version, give the package your own name and add a license before
publishing. Replace the template's unrestricted peer range with the versions you
test. Do not use a `workspace:*` dependency in an external package.

## Load into OpenScience

After reviewing the code, add its absolute module URL to your **global**
`~/.config/openscience/openscience.json` and restart:

```json
{
  "plugin": ["file:///absolute/path/to/openscience/examples/local-lab-plugin/index.ts"]
}
```

Global plugins are trusted host code; they are not isolated by the execution
sandbox. This setup keeps the execution sandbox enabled. A plugin declared by a
project requires project trust and is refused while that sandbox is enabled.
Use MCP for an external service integration that should not be imported into
the OpenScience host.

`science_list_dbs` now includes `local-lab`. Search with
`science_search({ db: "local-lab", query: "calibration" })`, fetch one record with
`science_fetch({ db: "local-lab", id: "calibration-a" })`, then call
`local_lab_summary({ values: [1, 2, 3] })`. In a model session, these calls use
your normal model and permission settings.

The expected result is three observations, mean 2, and a CSV containing
`count,mean` followed by `3,2`. The attachment remains part of the tool result;
it is not automatically a saved, versioned research artifact. To persist a
research result, use the existing artifact API and include the returned artifact
reference in your metadata.

`catalog.json` is a proposed directory submission record, not a configuration
file or an installation permission grant. Record checks you actually perform;
compatibility and scientific validity are different claims.
