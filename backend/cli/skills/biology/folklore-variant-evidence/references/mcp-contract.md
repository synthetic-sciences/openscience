# Folklore Clinical Variant Interpretation MCP public contract

Use this reference when constructing calls or interpreting public results. The
current public server card supplies the advertised input/output schemas:
<https://folklore.helena.bio/.well-known/mcp/server-card.json>.
The 2026-11-01 update reviewed these schemas for adapter 1.7.0 and eleven tools;
no scientific requests were executed. The current VUS prompt is `assess_vus`.

## Connection

- Endpoint: `https://api.helena.bio/folklore/v1/mcp`
- Authentication: none
- Transport: stateless Streamable HTTP
- Publisher: Helena Bioinformatics
- Adapter release: 1.7.0
- Hosted inventory: ten scientific tools plus the separate, opt-in `support_helena` helper
- Registry identity: `io.github.helena-bioinformatics/folklore`

Verify tools with `tools/list` at call time. Do not infer tool availability from
this skill alone.

## Current response contracts

Read transport/JSON-RPC failures, MCP `result.isError` and any non-null
`adapter_error` before scientific fields. In `result.structuredContent`:

- `classify_germline_variant` has `contract_version: "2"`, nullable `result`,
  nullable `record_url` and nullable `adapter_error`. Its nested result retains
  `search_contract_version: "1.0"` and the six explicit outcome states.
- Variant literature, publication details and corpus success use direct fields
  with `contract_version: "2"`: respectively `status`/`variant_result`/`literature`,
  `publication`, and `results`/retrieval metadata. Their adapter failures can use
  the classification-style envelope with `result: null`.
- Gene-disease success uses `contractVersion: "2"`, `status`, `query`,
  `associations`, `pagination`, `source` and `warnings`. Its failure carries
  `contractVersion` and `adapter_error` directly.
- Public gene tools use the version-2 envelope described below.

Current top-level schemas do not contain `usage_boundary`. Preserve scientific
limitations and provenance within the results. Missing required fields or an
unknown status are contract problems, not empty scientific results.

## Public gene profiles

Read HTTP/JSON-RPC failures and MCP `result.isError` before scientific fields.
For these four tools, let `s` be MCP `result.structuredContent`; each returns a
version-2 envelope with `contract_version`, `result`, `record_url` and
`adapter_error`.
Handle a non-null `adapter_error` first; `result` can be null on failure.
Text-only clients receive the same complete envelope as JSON text.

`resolve_gene` accepts only `query`: one printable public symbol, previous symbol,
alias, HGNC, Ensembl or NCBI Gene identifier, 1–128 characters. Preserve `exact`,
`alias`, `ambiguous`, `not_found` and `withdrawn`, the complete returned candidate
set and its completeness/count metadata. Require explicit selection for
ambiguity; do not choose a replacement for a withdrawn identity. Gene-plus-HGVS
expressions use the variant workflow instead.

After resolution, select `s.result.candidates[].identity.gene_id` and pass
`s.result.identity_snapshot_id` as `snapshot_id`. `gene_id` is a canonical
`HGNC:` identifier with a positive integer; snapshots are 64 lowercase hexadecimal
characters. Both fields are required for each of the other three new tools.
Do not fabricate values or carry a snapshot from another gene/profile.

`get_gene_profile` preserves these thirteen sections: `overview`,
`disease_validity`, `structure`, `constraint`, `dosage`, `mechanisms`,
`clinical_variants`, `clinical_variant_consequences`, `expression`, `gwas`,
`phenotypes`, `protein_pathways` and `literature`.

`get_gene_section` additionally requires one `section` from that set. Optional
`limit` is 1–50 (default 20); optional `cursor` is the returned opaque continuation
for that exact gene, snapshot and section. Preserve source assemblies/releases,
assertions, links, coverage, limitations, nulls, `total`, `observed_total` and
count units. An unknown total is not zero; overlapping clinical axes are not
additive, and mirrored assertions are not independent votes. Native GRCh37
transcript rows are reference evidence, not newly supported variant inputs.
Unavailable/unintegrated evidence differs from a source having no record.
For `snapshot_unavailable`, restart resolution and reload the entire profile;
never mix pages from different snapshots or construct/repair opaque cursors.

`search_gene_literature` takes the same resolved gene/snapshot, optional `limit`
1–25 (default 20), `sort` of `relevance`, `newest` or `oldest` (default relevance),
and an optional opaque cursor from the same gene/snapshot/sort capture. Preserve
`captured_at`, `capture_sha256`, records, match labels, source links, degradation
and continuation fields. Abstracts are excluded: do not append/hydrate them into
this capture. Live query-matched discovery is not guaranteed exact gene filtering
or curated gene-disease evidence; keep it separate from the immutable profile's
literature section. Gene validity, dosage, constraint and GWAS do not by
themselves establish variant pathogenicity or a patient diagnosis.

## `classify_germline_variant`

Required input:

```yaml
assembly: GRCh38
query: <one public germline nuclear SNV or simple indel>
```

The `query` may be a coordinate, genomic/coding/protein HGVS, SPDI, rsID, or a
returned `canonical_key` in this form:

```text
GRCh38:chrN:position:REF:ALT
```

The six public outcome states are:

- `resolved`
- `ambiguous`
- `not_found`
- `invalid_request`
- `unsupported`
- `resolution_unavailable`

Do not collapse these states. In particular, never convert `ambiguous` into
`resolved`, and never convert `resolution_unavailable` into `not_found`.

## `search_variant_literature`

Use only after resolution when composing an automatic workflow:

```yaml
assembly: GRCh38
query: <returned canonical_key>
question: <optional public scientific focus>
limit: <1 to 25>
```

The response preserves the variant result and returns literature only when the
variant resolution permits it. Publication match types are `exact_variant`,
`variant_alias`, and `gene_association`.

## `get_publication_details`

Input one PMID returned by a literature tool, as digits without a `PMID:`
prefix. Preserve the returned bibliographic metadata, source URLs, retraction
status, gene mentions, and variant mentions.

## `search_literature_corpus`

Use for source-linked scientific-literature discovery with a natural-language
question, publication identifier, gene, variant, phenotype, HPO, or OMIM
concept. Inspect the live input schema for current bounds and optional controls.
Keep all queries public and nonsensitive.

## Gene-disease assertions

Request examples (not captured scientific results):

```json
{"name":"get_gene_disease_associations","arguments":{"gene":"BRCA1","limit":20,"offset":0}}
```

```json
{"name":"search_disease_genes","arguments":{"disease":"Marfan","limit":20,"offset":0}}
```

The gene lookup accepts an exact gene symbol or HGNC identifier. Disease lookup accepts an exact MONDO identifier or a disease-name substring. Both have limit 1–50 and offset 0–1000. Preserve distinct disease matches and returned pagination; one page is not an exhaustive catalogue.

Successful structured output directly carries query, associations, pagination, source and warnings. Read JSON-RPC and adapter errors before interpreting output. The source is ClinGen Gene-Disease Validity; preserve assertion-specific inheritance, assessment, source links and dates. Missing source values stay unavailable. No result does not establish no association, and association validity is not variant pathogenicity.

## Interpretation scope

Classify one supported public variant and preserve its returned scientific
limitations. Review results with source provenance and qualified professional
judgment. Literature and gene associations remain separate from variant
classification. An empty bounded result does not establish universal absence.

## Current release sources

- Release: <https://github.com/helena-bioinformatics/folklore-mcp/releases/tag/folklore-mcp-v1.7.0>
- Current discovery: <https://folklore.helena.bio/.well-known/mcp/server-card.json>
- Public gene workflow: <https://github.com/helena-bioinformatics/folklore-mcp/blob/55a332c6dd6bd4650e921c12ac145b8e0f90476a/docs/PUBLIC_GENE_PROFILES.md>
