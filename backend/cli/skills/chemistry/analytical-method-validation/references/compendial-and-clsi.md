# Compendial, CLSI, and ISO Sources (No Standard Text)

Research basis: **2026-07-27**. This reference identifies documents, their scope, and where to obtain
them. **It does not reproduce their requirements, thresholds, or study designs**, because they are
copyrighted and paywalled.

## Copyright boundary

USP–NF general chapters, CLSI documents, and ISO/IEC standards are copyrighted works sold by their
publishers. Do not ask an agent to retrieve, transcribe, summarise clause-by-clause, reconstruct, or
store their text. Vendor application notes and training decks that quote them are equally
constrained, and a paraphrase that carries the same numbers is still a reproduction of the
substantive content.

The practical consequence: **when a numeric criterion or a study design lives in one of these
documents, read it from the authorised copy.** An agent asked for "the USP <621> tailing factor
limit" or "the CLSI EP15 number of days" will produce a plausible number. Plausible is not the same
as correct, and the difference is discovered at audit.

Record publisher, title, designation, edition, amendments, authorised location, access date, and
review date in the laboratory's controlled source register.

## USP–NF general chapters

| Chapter | Title | Scope |
| --- | --- | --- |
| `<1220>` | Analytical Procedure Life Cycle | Three-stage lifecycle: procedure design (Stage 1), performance qualification (Stage 2), ongoing performance verification (Stage 3), organised around an analytical target profile. Official 1 May 2022 (incorporated into USP–NF 2022 Issue 1 on 1 Nov 2021). Integrates the concepts previously spread across `<1224>`, `<1225>`, and `<1226>`. |
| `<1225>` | Validation of Compendial Procedures | Validation of non-compendial procedures, and of compendial procedures used outside their stated scope. Stage 2 activity under `<1220>`. |
| `<1226>` | Verification of Compendial Procedures | Assessment of selected performance characteristics showing a compendial procedure works under actual conditions of use. **Verification is not revalidation** and does not repeat the full validation. |
| `<1224>` | Transfer of Analytical Procedures | Transfer between laboratories. |
| `<1010>` | Analytical Data — Interpretation and Treatment | Statistical treatment of analytical data. |
| `<621>` | Chromatography | System suitability and chromatographic operating parameters, including the extent to which a compendial procedure may be adjusted without triggering revalidation. |
| `<711>` / `<1092>` | Dissolution / The Dissolution Procedure | Dissolution testing and development/validation of the procedure. |

Obtain from the USP–NF (<https://www.uspnf.com/>). Regional pharmacopoeias — Ph. Eur., JP, ChP —
carry their own general chapters; check which pharmacopoeia the specification cites, because
adjustment allowances and system suitability requirements differ between them.

**The `<1226>` decision.** Verification applies when using a compendial procedure as written and
within its scope. Two situations push you back to `<1225>` validation: using the procedure outside
its stated scope (a different matrix, a different dosage form, a concentration range it does not
cover), or modifying it beyond the adjustments the relevant chapter permits. Getting this wrong in
either direction is expensive — unnecessary full validation, or an unsupported claim of verification.

## CLSI EP series

Designations and titles below were taken from clsi.org listings and secondary sources on the
research date. **Editions change; confirm the current edition on <https://clsi.org/> before designing
a study.** Marked `[confirm]` where the edition was not read from the publisher directly.

| Designation | Subject | Note |
| --- | --- | --- |
| EP05 | Evaluation of precision of quantitative measurement procedures | Establishment of precision; the multi-day/multi-run designs. `[confirm edition]` |
| EP06 | Evaluation of linearity of quantitative measurement procedures | 2nd edition reported. `[confirm edition]` |
| EP07 | Interference testing in clinical chemistry | Screening, quantifying and confirming interferents; verifying manufacturer interference claims. 3rd edition reported. `[confirm edition]` |
| EP09 | Measurement procedure comparison and bias estimation using patient samples | The method-comparison document. 3rd edition reported. `[confirm edition]` |
| EP15 | User verification of precision and estimation of bias | The short study a laboratory runs to verify a manufacturer's claims. 3rd edition reported. `[confirm edition]` |
| EP17 | Evaluation of detection capability | Limit of blank, limit of detection, limit of quantitation; verification of manufacturer claims. `[confirm edition]` |
| EP25 | Evaluation of stability of in vitro diagnostic reagents | `[confirm edition]` |
| EP28 | Defining, establishing, and verifying reference intervals | Formerly designated C28. An implementation guide (EP28IG) also exists. `[confirm edition]` |

**Vocabulary.** CLSI distinguishes *limit of blank*, *limit of detection*, and *limit of quantitation*
as three separate quantities with separate protocols. This is not the same taxonomy as ICH Q2(R2)'s
detection limit and quantitation limit, and the two should not be translated into each other
casually — the underlying definitions and the experiments differ.

**Verification versus establishment.** For an FDA-cleared or CE-marked assay used as intended, a
laboratory *verifies* the manufacturer's performance claims — a bounded study. For a
laboratory-developed test, or an assay used off-label, the laboratory *establishes* performance,
which is a much larger exercise. Under CLIA the distinction has direct regulatory consequences and
also depends on test complexity. Determine which applies before designing anything.

## ISO standards

| Standard | Relevance |
| --- | --- |
| ISO/IEC 17025:2017 | Clause 7.2 selection, verification and validation of methods; clause 7.6 measurement uncertainty. Validation "to the extent necessary" for the intended application — no characteristic list, no numeric criteria. |
| ISO 15189 | Medical laboratories: quality and competence. The clinical-laboratory counterpart to 17025. |
| ISO 21748 / ISO 5725 series | Using repeatability, reproducibility and trueness estimates in measurement uncertainty; accuracy of measurement methods. |

Obtain from ISO (<https://www.iso.org/>) or a national member body. A laboratory is **accredited** to
ISO/IEC 17025 by an accreditation body — it is not "17025 certified", and writing "certified" is a
substantive error assessors notice.

For accreditation readiness, the quality manual, and the surrounding management system, use this
repository's `iso-standards-readiness` skill. This skill stays at the level of the individual
procedure.

## Environmental, food, and forensic method systems

Where a prescribed method system governs — a published EPA method, an AOAC Official Method, a
standard method for water or food analysis — the validation and quality-control requirements are
written into the method or the programme, and they take precedence. Do not substitute a
pharmaceutical framework. Common differences: matrix spike and duplicate requirements per batch,
prescribed calibration-verification frequencies, method detection limit procedures that differ from
both ICH and CLSI, and mandatory participation in proficiency testing schemes.
