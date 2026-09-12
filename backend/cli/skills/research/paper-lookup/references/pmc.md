# PMC (PubMed Central)

PMC is a **full-text archive** of biomedical and life sciences articles. It is separate from PubMed -- PubMed has citations/abstracts, PMC has full text. Not all PubMed articles are in PMC, and vice versa.

## E-utilities for PMC

### Base URL

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
```

Same E-utilities as PubMed, but with `db=pmc`.

### eSearch -- Search PMC

```
GET /esearch.fcgi?db=pmc&term={query}&retmode=json
```

Same parameters as PubMed eSearch. Returns PMC UIDs (numeric, e.g., `13033346`). You need to prepend "PMC" to get a PMCID (e.g., `PMC13033346`).

### eFetch -- Get Full Text XML

```
GET /efetch.fcgi?db=pmc&id={pmcid}&retmode=xml
```

| rettype | retmode | Returns |
|---------|---------|---------|
| *(omit)* | `xml` | JATS XML -- full text **only for open-access articles**; metadata only otherwise, with no error. See the hazard below before using this. |
| `medline` | `text` | MEDLINE format |

**Example:**
```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=7029759&retmode=xml
```

The XML uses JATS (Journal Article Tag Suite) format:
- `<front>` -- journal metadata, article metadata, author info
- `<body>` -- full article text with `<sec>` sections, `<p>` paragraphs, `<fig>` figures
- `<back>` -- `<ref-list>` with all references

Pass numeric IDs only (not "PMC7029759", just "7029759").

### Hazard: eFetch returns metadata-only XML for non-OA articles, with HTTP 200

This is the most dangerous failure in this skill, because nothing about the response says it failed.
When the publisher does not permit XML redistribution, eFetch returns a **well-formed
`<pmc-articleset>`** containing `<front>` metadata, **no `<body>`**, and the reason as an XML
*comment* -- which every standard parser discards. Verified 2026-07-27 on PMCID 1500000:

```
HTTP/1.1 200 OK

<pmc-articleset><article article-type="obituary" ...>
  <!--The publisher of this article does not allow downloading of the full text in XML form.-->
  <front>...</front>
</article></pmc-articleset>
```

An agent that fetches this, parses it, and reports "retrieved full text" has retrieved only the
title, journal, and author list. **This is the common case, not an edge case:** full text via eFetch
is limited to roughly the 3M-article PMC Open Access Subset, while PMC holds ~10M — so most PMCIDs
you hand to eFetch come back without a body.

**Always confirm `<body>` exists before claiming you have full text.** Three ways, in order of
preference:

1. **Check availability first** with the PMC OA Web Service (below). It tells you whether a package
   exists before you spend the fetch.
2. **Use `scripts/jats_to_text.py`**, which exits non-zero with `no <body> element` when the article
   is metadata-only and surfaces the publisher-restriction comment instead of dropping it.
3. **Fall back to Europe PMC** (`references/europepmc.md`), whose `fullTextXML` endpoint returns a
   clean **404** for the same article rather than a 200 with no body -- an honest failure is easier to
   handle than a plausible one.

If full text is unavailable, say so explicitly and offer the abstract (PubMed eFetch) or an OA copy
elsewhere (Unpaywall, CORE) rather than presenting `<front>` metadata as the article.

## PMC OA Web Service -- is full text actually available?

Not the same thing as the ID Converter: this answers "does a downloadable full-text package exist
for this PMCID", which is exactly what the eFetch hazard above requires you to know in advance.

```
GET https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={pmcid}
```

Returns XML (no JSON option). Verified 2026-07-27:

```xml
<OA><records returned-count="1" total-count="1">
  <record id="PMC7029759" citation="F1000Res. 2020 Feb 7; 9:72" license="CC BY" retracted="no">
    <link format="tgz" updated="2024-04-23 12:25:15"
          href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_package/e5/c9/PMC7029759.tar.gz"/>
  </record>
</records></OA>
```

Distinguish the two failure codes -- they mean different things and both arrive with **HTTP 200**:

| Response | Meaning |
|---|---|
| `<records>` with a `<record>` and `<link>` | In the OA Subset; full text is retrievable |
| `<error code="idIsNotOpenAccess">` | The article exists but is **not** in the OA Subset -- eFetch will return metadata only. This is the case to route to Europe PMC or Unpaywall. |
| `<error code="idDoesNotExist">` | No such PMCID. A bad identifier, not a coverage gap -- re-check the format or convert via the ID Converter. |

Per-record attributes worth reading:

| Attribute | Why it matters |
|---|---|
| `license` | The actual reuse terms (`CC BY`, `CC BY-NC`, ...). Report these when you quote or redistribute text. |
| `retracted` | `"no"` or `"yes"`. Summarizing a retracted paper as current evidence is a correctness failure, not a formatting one -- check it before quoting. |
| `citation` | Human-readable citation string, handy for provenance. |

`format` values are `tgz` (article XML plus figures) and sometimes `pdf`. **The `href` is an FTP URL,
and swapping the scheme to HTTPS does not work** -- `https://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_package/...`
returns 404 (verified 2026-07-27). Use the FTP URL as given, or get the same XML over HTTPS from
eFetch / Europe PMC `fullTextXML` once this service has confirmed the article is in the subset.

## BioC API -- Structured Full Text

An alternative way to get full text in a structured passage format.

### Base URL

```
https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/
```

### Endpoint

```
GET /BioC_{format}/{id}/{encoding}
```

| Parameter | Values |
|-----------|--------|
| `format` | `json` or `xml` |
| `id` | PMID (e.g., `17299597`) or PMCID (e.g., `PMC7029759`) |
| `encoding` | `unicode` or `ascii` |

**Example:**
```
https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/PMC7029759/unicode
```

**Response structure (JSON):**
```json
{
  "source": "PMC",
  "documents": [{
    "id": "PMC7029759",
    "infons": {"license": "...", "doi": "..."},
    "passages": [
      {
        "offset": 0,
        "infons": {"section_type": "TITLE"},
        "text": "Article title..."
      },
      {
        "offset": 42,
        "infons": {"section_type": "ABSTRACT"},
        "text": "Abstract text..."
      },
      {
        "offset": 500,
        "infons": {"section_type": "INTRO"},
        "text": "Introduction text..."
      }
    ]
  }]
}
```

Section types: `TITLE`, `ABSTRACT`, `INTRO`, `METHODS`, `RESULTS`, `DISCUSS`, `CONCL`, `REF`, `SUPPL`, `FIG`, `TABLE`

**Coverage:** ~3 million articles from the PMC Open Access Subset.

## PMC ID Converter API

Converts between PMID, PMCID, DOI, and Manuscript ID.

### Base URL

```
https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `ids` | Yes | Up to 200 comma-separated IDs |
| `idtype` | No | `pmcid`, `pmid`, `mid`, `doi` (default: auto-detect) |
| `format` | No | `json`, `xml`, `csv` (default: xml) |
| `tool` | Recommended | Your application name |
| `email` | Recommended | Your contact email |

**Example:**
```
https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=PMC7029759&format=json
```

**Response:**
```json
{
  "status": "ok",
  "records": [{
    "pmcid": "PMC7029759",
    "pmid": "32117569",
    "doi": "10.12688/f1000research.22211.2"
  }]
}
```

Only returns results for articles that are in PMC. If an article is in PubMed but not PMC, no PMCID will be returned.

## Rate Limits

| Service | Limit |
|---------|-------|
| E-utilities (`db=pmc`) | 3/sec without key, 10/sec with key |
| BioC API | Follow general NCBI policy (3/sec without key) |
| ID Converter | Follow general NCBI policy |

Include `tool` and `email` parameters on E-utility requests. Large batch jobs should run outside peak hours (Mon-Fri 5AM-9PM ET).
