# ISO/IEC 17025 Process Framework (No Standard Text)

Research basis: **2026-07-26**. This reference summarizes a preparation process and
evidence architecture for testing and calibration laboratory competence work. It does
not reproduce requirements and is not a substitute for the standard.

## Copyright and authorized access

ISO and IEC publications are copyrighted. Obtain ISO/IEC 17025 from
[ISO](https://www.iso.org/standard/66912.html), IEC, an ISO national member, or another
authorized source; see [ISO copyright](https://www.iso.org/copyright.html). Do not ask
an agent to retrieve, transcribe, summarize clause-by-clause, or store proprietary
text. Accreditation-body checklists that quote the standard are equally copyrighted and
are usually licensed only to the accredited laboratory.

## Current edition

- [ISO/IEC 17025:2017](https://www.iso.org/standard/66912.html) is Edition 3. No
  successor edition was identified at the research basis date — confirm on the ISO
  catalogue page, which refused automated access during that research.
- The 2017 edition restructured the 2005 edition around laboratory activities and
  risk-based thinking. A quality system still organized around the 2005 clause
  structure is out of date; do not treat a 2005-era manual as a current gap baseline.
- Record publisher, title, edition, amendments/corrigenda, authorized location, access
  date, source owner, currency-review date, impact decision, and approval in the
  controlled source ledger.

## The vocabulary trap: laboratories are accredited, not certified

A laboratory is **accredited** to ISO/IEC 17025 by an accreditation body. It is not
"ISO 17025 certified," and no certification body issues an ISO/IEC 17025 certificate.
Writing "certified" in a report, tender response, or quality manual is a substantive
error that assessors and customers both notice.

- Accreditation bodies operate under ISO/IEC 17011 and are peer-evaluated through the
  recognition arrangement. Certification bodies operate under ISO/IEC 17021-1. These
  are different schemes with different scope statements.
- Since **2026-01-01**, Global Accreditation Cooperation Incorporated has replaced the
  former ILAC and IAF and operates its own Multilateral Recognition Arrangement.
  Results and certificates issued under the former ILAC MRA / IAF MLA remain
  recognized during the transition. Verify current logo, claim, and endorsement wording
  with the accreditation body before reproducing any of it.
- ISO/IEC 17025 accreditation is not ISO 9001 certification, not a product approval,
  not a regulatory authorization, and not a statement that any particular result is
  correct.

## Hard boundary

This skill and its files cannot:

- accredit a laboratory, issue or validate an accreditation certificate or schedule,
  or predict an assessment outcome;
- decide which accreditation scheme, jurisdiction requirement, or customer
  specification applies;
- replace the laboratory's technical management, quality manager, authorized signatory,
  accreditation body, assessor, or proficiency-testing provider;
- validate a method, compute or approve a measurement uncertainty budget, establish
  metrological traceability, or judge whether a decision rule is fit for purpose; or
- infer competence from a document title, keyword, template, checklist, or script
  result.

Use outputs as a list of evidence questions for accountable human review.

## Scope of accreditation is per activity, not per organization

The accredited scope is defined item by item: field or discipline, method or procedure
and its issue, the measurand or property determined, and the range with the reported
uncertainty basis. For calibration laboratories this is normally expressed through
calibration and measurement capability statements.

Consequences for evidence preparation:

- Work outside the accredited scope must not carry an accreditation claim or
  endorsement, even at an accredited site under an accredited quality system.
- A method change, a range extension, a new location, or a new authorized signatory is
  a scope question, not only an internal change-control question.
- Subcontracted work has its own rules for customer notification and for the
  subcontractor's own accreditation status. Record both.

Capture scope items with:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate_scope_intake.py \
  /path/to/laboratory-scope-intake.json --standard iso-17025
```

Copy `assets/templates/laboratory-scope-intake-template.json` outside the skill first.
The distributed template fails closed by design.

## Process and evidence domains

The `iso-17025` profile carries these domain labels for manifests and gap reports.
They are workflow topics, not clause references:

`scope-and-impartiality`, `organizational-structure-and-management`,
`personnel-competence`, `facilities-and-environmental-conditions`,
`equipment-and-calibration`, `metrological-traceability`,
`externally-provided-products-and-services`, `review-of-requests-and-contracts`,
`method-selection-verification-and-validation`, `sampling`, `handling-of-items`,
`technical-records`, `measurement-uncertainty`,
`validity-of-results-and-proficiency-testing`, `reporting-and-decision-rules`,
`complaints`, `nonconforming-work`, `data-and-information-management`,
`internal-audit`, `management-review`, `corrective-action-and-improvement`.

Each domain needs an owner, status, evidence IDs, source/version reference, recorded
approval, and links to open gaps. Sample **records**, not only procedures: a procedure
describing uncertainty evaluation is not evidence that a budget exists for a reported
measurand.

## The four technical areas that carry most findings

### 1. Metrological traceability

Traceability is a documented, unbroken chain to a stated reference with stated
uncertainty at each step — not a drawer of calibration certificates. The governing
policy is **ILAC P10:07/2020** (implementation July 2021, revised for the 2017
edition); confirm its current designation, since the P/G series numbering may move
under GLOBAC.

Evidence to assemble per measurement: the stated reference, the calibration provider
and its accreditation status and scope, certificate identity and date, the uncertainty
contribution carried forward, interval justification, and intermediate-check records.

### 2. Measurement uncertainty

Record which measurands have evaluated uncertainty, the evaluation basis, the
contributions included, how uncertainty is reported, and how it interacts with the
decision rule. An uncertainty budget that exists only in a spreadsheet with no
controlled revision, owner, or approval is a gap, not evidence.

This skill does not compute uncertainty. For the repo's uncertainty tooling, see the
`uncertainty-and-units` skill; its outputs still require authorized technical review
before entering a controlled record.

### 3. Method selection, verification, and validation

Distinguish, per scope item: a standard method used as published, a standard method
requiring verification of the laboratory's ability to perform it, a modified standard
method, and a laboratory-developed method. The evidence expected differs in each case.
Record the performance characteristics evaluated, the acceptance criteria, the data,
and the authorized approval to put the method into service.

### 4. Decision rules and statements of conformity

If reports state conformity to a specification, the decision rule must be documented,
agreed with the customer where required, and applied consistently — including how
measurement uncertainty is treated at the specification limit. The guidance basis is
**ILAC G8:09/2019**, with JCGM 106:2012 / ISO/IEC Guide 98-4 as the metrological
companion. Confirm current issues before citing either in a controlled procedure.

Assemble, per scope item that reports conformity: the rule, the agreement record, the
uncertainty treatment, the report wording, and the authorized signatory.

## Validity of results and proficiency testing

Interlaboratory comparison and proficiency-testing participation is monitoring
evidence, and a passing result is not a competence conclusion. Record the plan (which
scope items, what frequency, what provider), each result, the evaluation against
acceptance criteria, and — most importantly — the investigation and corrective action
for any questionable or unsatisfactory outcome. An unsatisfactory result with no
documented investigation is a blocker; treat it as one.

Where the laboratory cannot participate because no scheme exists for a measurand,
record the alternative approach and its authorization rather than leaving a silence.

## Shared checks that apply here

- `scripts/audit_document_records.py` — controlled documents, technical records,
  retention basis, and external-source currency. Standard-agnostic.
- `scripts/check_capa.py` — nonconforming work and corrective action, including
  effectiveness evidence before closure.
- `scripts/check_supplier_controls.py` — externally provided products and services,
  including calibration providers, reference-material suppliers, and subcontracted
  laboratories.
- `scripts/validate_evidence_manifest.py` and `scripts/gap_analyzer.py` with
  `--standard iso-17025` — bounded evidence manifest and domain-level gap view.

`scripts/check_traceability.py` and `scripts/check_qmsr_transition.py` are
device-lifecycle checks and do not apply to laboratory accreditation work. Note that
`check_traceability.py` concerns design/risk traceability, **not** metrological
traceability — the words collide and the check is the wrong tool here.

## Common preparation failures

- Claiming "ISO 17025 certified" instead of accredited, or attaching an accreditation
  symbol to results outside the accredited scope.
- Treating calibration certificates as traceability evidence without the uncertainty
  chain, provider scope, or interval justification.
- Reporting conformity with no documented decision rule, or a rule that ignores
  uncertainty at the limit.
- Verifying a standard method once at introduction and never revisiting it after a
  method issue, instrument, or personnel change.
- Recording proficiency-testing scores while leaving unsatisfactory results
  uninvestigated.
- Presenting an impartiality statement with no identified risks, no controls, and no
  review.
- Filing a document register as the deliverable when no technical records were sampled.

## Sources

- [ISO/IEC 17025:2017](https://www.iso.org/standard/66912.html) — catalogue entry
- [ISO/IEC 17025 landing page](https://www.iso.org/ISO-IEC-17025-testing-and-calibration-laboratories.html)
- [ILAC policy series](https://ilac.org/publications-and-resources/ilac-policy-series/) — P10 traceability policy
- [GLOBAC launch](https://iaf.nu/en/news/global-accreditation-cooperation-incorporated-launch-unifies-international-accreditation-organisations-and-strengthens-worldwide-trust/)
- [Specifying use of GLOBAC accreditation](https://ilac.org/latest_ilac_news/iaf-and-ilac-release-information-on-specifying-use-of-globac-accreditation/)
- `references/source-ledger.md` — dated baseline and provenance limitations
- `references/assurance-lanes.md` — how this lane differs from certification and
  regulatory inspection
