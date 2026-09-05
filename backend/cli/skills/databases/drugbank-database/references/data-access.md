# DrugBank data access

## Supported local workflow

`scripts/drugbank_helper.py` reads an extracted DrugBank XML export using Python's
standard library. It never signs in, downloads a dataset, or searches the user's
filesystem for one. Supply the file the user authorized for this analysis:

```python
from scripts.drugbank_helper import DrugBankHelper

db = DrugBankHelper(xml_path="/path/to/licensed/drugbank.xml")
drug = db.get_drug_info("DB00001")
```

For repeated use, set `DRUGBANK_XML_PATH` to that file and construct
`DrugBankHelper()`. An explicit `xml_path` takes precedence over the environment.
Callers that already parsed an export may pass `DrugBankHelper(root=root)`.
The first query loads the XML; subsequent queries reuse the same root.

Keep the export private and record its version and checksum for reproducibility.
Do not publish DrugBank records or redistribute the export unless the user's
license permits it. Full XML exports can require substantially more memory than
their on-disk size; use a streaming XML parser for analyses that do not need the
helper's random-access behavior.

## Obtaining data is a separate prerequisite

Use the [official release page](https://go.drugbank.com/releases/latest) and the
user's applicable license. As checked September 5, 2026, that page states academic
downloads are temporarily paused. A free account is not proof that an export is
available. If the user has no authorized local copy, explain this prerequisite;
do not substitute an unlicensed mirror or older dataset.

`drugbank-downloader` is a real third-party package, not a missing bundled module:
[maintainer repository](https://github.com/cthoyt/drugbank-downloader). Its maintainers
warn that they cannot verify access to newer datasets. Installing it does not
grant a license or restore unavailable downloads. If a user explicitly requests
that package and has authorized access, consult its current documentation, pin
the requested data version, and pass the resulting XML root to the helper. The
bundled helper does not invoke it implicitly.

## Errors

- **Data is not configured:** supply `xml_path`, `DRUGBANK_XML_PATH`, or a root.
- **XML was not found:** verify the explicit path; do not scan unrelated folders.
- **Could not be parsed:** supply extracted, complete XML rather than a ZIP archive.
- **Not a DrugBank export:** the expected root is `drugbank` in the
  `http://www.drugbank.ca` namespace. See the [XML reference](https://docs.drugbank.com/xml/).
- **No matching drug:** `get_drug_info()` returns `{}` when the ID is absent from
  the supplied export. This is different from unavailable or malformed data.

## Hosted API

The hosted API is a separate licensed product, not the XML helper's transport.
Consult [DrugBank's API reference](https://docs.drugbank.com/v1/) for its current
endpoint, authentication and account-specific access. Do not infer API access,
request quotas, or regional coverage from possession of an XML export.
