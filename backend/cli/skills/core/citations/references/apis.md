# Scholarly metadata APIs

All public, no key required. Use `webfetch` with the URL; JSON unless noted. Include a
descriptive `User-Agent` or `mailto` where the service asks for one (Crossref, OpenAlex)
to land in the polite pool.

## Contents

- Crossref
- OpenAlex
- arXiv
- PubMed E-utilities
- Semantic Scholar
- Unpaywall (open-access copies)
- Resolving a DOI to BibTeX

## Crossref

- Title search: `https://api.crossref.org/works?query.bibliographic=<title>&rows=3&mailto=<email>`
  Look at `message.items[*].title[0]`, `author[*].family`, `issued['date-parts']`,
  `container-title[0]`, `DOI`.
- By DOI: `https://api.crossref.org/works/<doi>` (URL-encode the DOI).
- Filters: `&filter=from-pub-date:2023-01-01,type:journal-article`.
- Crossref covers journals and most conference proceedings; it does not cover arXiv-only
  preprints or many ML conference papers published only on OpenReview.

## OpenAlex

- Search: `https://api.openalex.org/works?search=<title or query>&per-page=5&mailto=<email>`
- By DOI: `https://api.openalex.org/works/https://doi.org/<doi>`
- By arXiv: `https://api.openalex.org/works?filter=ids.openalex:...` or search the title.
- Useful fields: `display_name`, `publication_year`, `authorships[*].author.display_name`,
  `primary_location.source.display_name`, `doi`, `cited_by_count`, `open_access.oa_url`,
  `referenced_works` (for citation chasing), `related_works`.
- Filters: `&filter=publication_year:2024,type:article`; sort `&sort=cited_by_count:desc`.

## arXiv

- Query: `http://export.arxiv.org/api/query?search_query=ti:%22<title words>%22&max_results=5`
  (Atom XML). Fields per `<entry>`: `<id>` (contains the arXiv id), `<title>`,
  `<author><name>`, `<published>`, `<arxiv:doi>` when the authors added one.
- By id: `http://export.arxiv.org/api/query?id_list=2401.01234`
- Versioned ids (`v2`) pin a revision; cite without the version unless the version matters.

## PubMed E-utilities

- Search: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<query>&retmode=json&retmax=5`
  → `esearchresult.idlist`.
- Summary: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<pmids>&retmode=json`
  → `result[<pmid>].title`, `.authors[*].name`, `.fulljournalname`, `.pubdate`,
  `.articleids[*]` (doi, pmc).
- Abstract: `efetch.fcgi?db=pubmed&id=<pmid>&rettype=abstract&retmode=text`.
- Rate: 3 requests/second without a key.

## Semantic Scholar

- `https://api.semanticscholar.org/graph/v1/paper/search?query=<query>&limit=5&fields=title,authors,year,venue,externalIds,citationCount,abstract`
- By id: `.../paper/DOI:<doi>` or `.../paper/arXiv:<id>` with the same `fields`.
- Rate-limited without a key (about 1 request/second); use it for citation counts and
  abstracts, not as the primary resolver.

## Unpaywall

- `https://api.unpaywall.org/v2/<doi>?email=<email>` → `best_oa_location.url_for_pdf`.
  Only for finding a legal open-access copy to read.

## Resolving a DOI to BibTeX

`https://doi.org/<doi>` with header `Accept: application/x-bibtex` returns a BibTeX entry
from the publisher's metadata. Tidy it: rewrite the key to `firstauthorYEARkeyword`, brace
protected capitals, drop `abstract`, keep `doi`. Publisher entries sometimes carry
`month`, `publisher` and `url` fields you do not need; conference entries often lack
`booktitle` and need it added from the record.
