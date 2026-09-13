---
name: patent-mining
description: Retrieves and interprets patent data with the conventions that make counts and claims defensible, covering Google Patents, Lens, EPO Open Patent Services, USPTO data through PatentsView and the Open Data Portal, and WIPO PATENTSCOPE, together with kind codes, DOCDB and INPADOC families, priority versus filing versus publication dates, CPC and IPC classification, claim structure, assignee normalization and the limits of chemistry in patents, and records every query with the date it was run. Use for prior-art checks, freedom-to-operate scoping, technology landscapes, assignee or inventor analyses and patent-derived chemistry; use literature-review for scholarly sources and research-lookup for one quick fact.
summary: "Patent sources, kind codes, families, dates, CPC and claims; document queries and dates."
category: research
allowed-tools: [Read, webfetch, research_search, literature]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Patent mining

Patent data is jurisdiction-specific, dated several ways, and duplicated across family
members. A count means nothing without the source, the date field, the family definition
and the exact query on the day it ran. Treat every number as "N documents matching Q in
source S on date D", and write it that way.

## Data sources

1. **Google Patents** (patents.google.com): full text across many offices with machine
   translation, CPC browsing, similar-document search and CSV export of result lists. No
   official API; for bulk SQL use the Google Patents Public Datasets on BigQuery
   (`patents-public-data.patents.publications`).
2. **Lens** (lens.org): patents linked to scholarly works, families and citations, free
   account with API access (`https://api.lens.org/patent/search`, token-authenticated,
   fair-use quotas) and structured exports.
3. **EPO Open Patent Services** (OPS, version 3.2): REST and XML over OAuth2 client
   credentials, base `https://ops.epo.org/3.2/rest-services/`, with bibliographic data,
   DOCDB and INPADOC family lookups (`family/publication/docdb/<CC>.<number>.<kind>`),
   legal events, full text for EP and WO documents and images; 4 GB per week is free.
   Espacenet is the same data through a browser and the reference for families.
4. **USPTO**: PatentsView provided disambiguated inventors and assignees, CPC and claim
   text; during 2026 it is moving to the USPTO Open Data Portal (data.uspto.gov), the
   legacy `search.patentsview.org` API is being retired and ODP issues its own API keys,
   so check current status before scripting. Patent Public Search (ppubs.uspto.gov) covers
   US full text; Patent Assignment Search covers ownership changes.
5. **WIPO PATENTSCOPE** (patentscope.wipo.int): PCT applications (WO) in full text, many
   national collections, and chemical structure search.
6. **Chemistry in patents**: SureChEMBL extracts structures from patent text and images;
   Google Patents and PubChem link compounds to documents. Markush claims define generic
   families that cannot be enumerated exactly; text-mined structures include reagents,
   prior-art compounds and intermediates, so "appears in the patent" is not "claimed".
   Chemistry hits need a reading of the claims to say what is protected.

## Conventions

7. **Numbers and kind codes.** Country code, serial, kind: US 10,123,456 B2; EP 1 234 567
   B1; WO 2020/123456 A1. US kinds: A1 pre-grant publication, A2 republication, B1 grant
   without prior publication, B2 grant after publication, E reissue, S design. EP kinds:
   A1 application with search report, A2 without, A3 search report published separately,
   B1 grant, B2 specification amended after opposition. WO: A1 with international search
   report, A2 without, A3 report published later. Counting without a kind filter counts an
   invention twice (application and grant).
8. **Families.** DOCDB simple family: members share exactly the same priorities, roughly
   one invention. INPADOC extended family: members linked through any priority,
   transitively, so it merges related inventions. Count families for "how many
   inventions", publications for "how many documents", and name the family type.
9. **Dates.** Priority date (earliest claimed filing; the novelty date), filing date of
   this application, publication date (about 18 months after priority), grant date, PCT
   national-phase entry. Time series of inventive activity use priority or earliest filing
   date. The 18-month lag means the last 18 to 24 months are incomplete; mark that window
   as truncated on every plot and table.
10. **Classification.** IPC (WIPO, hierarchical, `C07D 401/04`) and CPC (EPO and USPTO,
    an IPC superset with about 250,000 symbols and a `Y` section for cross-cutting tags
    such as Y02 climate technologies). Distinguish inventive from additional symbols, and
    "current" CPC (reclassified over time) from CPC at publication. Cite the CPC scheme
    page for every code range you use, since titles are not self-explanatory.
11. **Claims.** Independent claims stand alone; dependent claims narrow a parent
    ("according to claim 1"). Scope lives in the claims, not the abstract. Parse claim
    numbers and dependency references; note transitional phrases ("comprising" is open,
    "consisting of" is closed). Quote claim text rather than paraphrasing it.
12. **Assignees.** Raw names vary in case, punctuation and legal suffix. Prefer
    disambiguated identifiers where a source provides them, or PATSTAT standardized names;
    otherwise normalize (case fold, strip suffixes, manual mapping for subsidiaries) and
    publish the mapping. Assignee at publication differs from current owner after
    reassignment; applicant, assignee and inventor are three different roles.
13. **Legal status.** Pending, granted, lapsed, expired, opposed, revoked; INPADOC legal
    events via OPS. A published application is not "a patent"; term is generally 20 years
    from filing, subject to fees and adjustments.

## Workflow

- [ ] Question restated as unit (families, publications, grants), jurisdictions, date
      field and window.
- [ ] Query saved verbatim in the source's syntax, with run date and result count.
- [ ] Export identifiers: publication number with kind, family id, priority date, CPC,
      raw and normalized assignee.
- [ ] Deduplicate by family, filter kinds, flag the truncation window.
- [ ] Read and quote the claims of load-bearing documents, not just abstracts.
- [ ] Report sources, queries, dates, counts at each step and every definition used.

## Sources

- EPO Open Patent Services: https://www.epo.org/en/searching-for-patents/data/web-services/ops
- EPO, patent families (DOCDB and INPADOC): https://www.epo.org/en/searching-for-patents/helpful-resources/first-time-here/patent-families
- USPTO kind codes: https://www.uspto.gov/patents/apply/applying-online/kind-codes
- PatentsView transition guide to the USPTO Open Data Portal: https://patentsview.org/apis/api-endpoints
- WIPO International Patent Classification: https://www.wipo.int/classifications/ipc/en/
- Cooperative Patent Classification scheme: https://www.cooperativepatentclassification.org/
- Lens API documentation: https://docs.api.lens.org/
- SureChEMBL: https://www.surechembl.org/
