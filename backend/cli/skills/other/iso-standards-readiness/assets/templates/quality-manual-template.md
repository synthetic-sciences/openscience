# Quality Manual Working Template

> **STATUS: DRAFT EXAMPLE — NOT APPROVED — NO CONFORMITY OR COMPLIANCE CLAIM**
>
> This generic structure is an authoring aid. It cannot determine applicability,
> establish an effective QMS, support a certification claim by itself, or replace
> authorized management, RA/QA, legal, regulatory, notified-body, or certification-
> body review. Obtain ISO standards from ISO or an authorized source; do not paste
> copyrighted ISO text into this file.

## 0. Controlled-document metadata

| Field | Required entry |
|---|---|
| Document ID | `<assigned controlled ID>` |
| Revision | `<revision>` |
| Status | `draft` / `in-review` / `approved` |
| Owner | `<accountable role>` |
| Effective date | `<YYYY-MM-DD after approval>` |
| Supersedes | `<document ID/revision or none>` |
| Evidence repository | `<controlled location>` |
| Confidentiality | `<classification>` |

### Approval

| Approval role | Named approver | Decision | Date | Approval evidence ID |
|---|---|---|---|---|
| Authorized management | `<name/role>` | `pending` | `<YYYY-MM-DD>` | `<record ID>` |
| RA/QA | `<name/role>` | `pending` | `<YYYY-MM-DD>` | `<record ID>` |
| Document control | `<name/role>` | `pending` | `<YYYY-MM-DD>` | `<record ID>` |

**Release gate:** keep status `draft` until every required approver records a decision,
open placeholders are resolved, referenced procedures exist, and training/change
impacts are approved.

## 1. Purpose and limits

- Intended use of this manual: `<organization-specific purpose>`
- What this manual does not establish: certification, regulatory applicability,
  product authorization, FDA compliance, MDSAP acceptance, or EU conformity.
- Authorized roles that own those determinations: `<roles and escalation route>`

## 2. QMS scope

| Scope element | Declared information | Owner | Status | Evidence ID | Approval ID |
|---|---|---|---|---|---|
| Legal entity/entities | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Sites and addresses | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Product families | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Lifecycle activities | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Outsourced processes | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Markets considered | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |

### 2.1 Applicability decisions

Do not infer applicability from a checklist. Record each decision made by an
authorized human.

| Topic/process | Decision | Rationale | Source/version | Decision owner | Approval/date |
|---|---|---|---|---|---|
| `<topic>` | `applicable` / `not-applicable` / `undetermined` | `<rationale>` | `<official source>` | `<role>` | `<record>` |

`Undetermined` is a blocking status. A `not-applicable` entry requires a documented,
approved rationale and must not be described as an automatic exclusion.

## 3. Controlled source and version basis

| Source ID | Official title | Edition/version/date | Authorized location | Currency review date | Owner | Impact approval |
|---|---|---|---|---|---|---|
| `<ID>` | `<title>` | `<version>` | `<location/URL>` | `<YYYY-MM-DD>` | `<role>` | `<record ID>` |

At minimum, distinguish the source basis used for:

- ISO 13485 certification preparation;
- FDA QMSR and current 21 CFR Part 820;
- MDSAP audit preparation;
- EU MDR or IVDR conformity assessment;
- product- and market-specific requirements.

## 4. Governance, authority, and responsibilities

| Role | Authority and responsibility | Independence/escalation | Delegate | Competence evidence | Approval |
|---|---|---|---|---|---|
| Top management | `<entry>` | `<entry>` | `<entry>` | `<ID>` | `<ID>` |
| Authorized management representative | `<entry>` | `<entry>` | `<entry>` | `<ID>` | `<ID>` |
| RA/QA owner | `<entry>` | `<entry>` | `<entry>` | `<ID>` | `<ID>` |
| Process owner | `<entry>` | `<entry>` | `<entry>` | `<ID>` | `<ID>` |
| Document/record owner | `<entry>` | `<entry>` | `<entry>` | `<ID>` | `<ID>` |

## 5. Process architecture and interactions

Use organization-specific processes. Do not copy a standard's clauses as procedures.

| Process | Inputs | Outputs | Owner | Controlled procedure | Records/evidence | Measures | Approval |
|---|---|---|---|---|---|---|---|
| Scope and quality planning | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Document and record control | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Risk management | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Design and development | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Supplier controls | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Production/service | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Validation and software assurance | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Identification/traceability | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Complaints, feedback, vigilance | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Nonconformity and CAPA | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Internal audit | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Management review | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Training and competence | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |
| Change control | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<IDs>` | `<measure>` | `<ID>` |

Attach an approved process interaction map as evidence: `<record ID/location>`.

## 6. Documentation and record controls

- Document lifecycle and approval method: `<procedure ID>`
- Record integrity, retrieval, retention, and disposition: `<procedure ID>`
- External-source version monitoring: `<procedure/register ID>`
- Electronic signatures/access controls: `<validated control IDs>`
- Training before effective use: `<procedure/evidence IDs>`
- Change-impact and linked-document updates: `<procedure/evidence IDs>`

## 7. Product lifecycle controls

For each applicable process, describe the policy-level approach and reference
controlled evidence. Cover, as applicable:

- requirements and product planning;
- risk management through production and postmarket feedback;
- design/development planning, reviews, transfer, and changes;
- supplier and outsourced-process controls;
- production, service, infrastructure, work environment, and process controls;
- process, test-method, equipment, and software validation;
- identification, distribution, and traceability;
- acceptance, release, preservation, installation, and servicing.

| Topic | Policy summary | Owner | Procedure | Evidence set | Status | Approval |
|---|---|---|---|---|---|---|
| `<topic>` | `<organization-specific summary>` | `<role>` | `<ID>` | `<IDs>` | `draft` | `<ID>` |

## 8. Feedback, postmarket, and improvement controls

Document the links among feedback, complaints, reportability/vigilance decisions,
risk updates, nonconformity, CAPA, change control, and management review.

| Link | Method | Owner | Input evidence | Output evidence | Approval |
|---|---|---|---|---|---|
| Complaint → reportability review | `<entry>` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |
| Postmarket signal → risk update | `<entry>` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |
| Nonconformity → CAPA decision | `<entry>` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |
| CAPA → effectiveness review | `<entry>` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |
| Change → validation/training | `<entry>` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |

## 9. Assurance and oversight

| Activity | Scope/frequency basis | Independence | Owner | Evidence | Open actions | Approval |
|---|---|---|---|---|---|---|
| Internal audit | `<risk-based basis>` | `<controls>` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |
| Management review | `<planned basis>` | `n/a` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |
| Supplier monitoring | `<risk-based basis>` | `<controls>` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |
| Validation review | `<change/risk basis>` | `<controls>` | `<role>` | `<IDs>` | `<IDs>` | `<ID>` |

## 10. Appendices

- Controlled procedure and record index: `<ID>`
- Source/version ledger: `<ID>`
- Organization chart and role authorizations: `<ID>`
- Process interaction map: `<ID>`
- Product/site/scope register: `<ID>`
- Risk-design-production-postmarket traceability matrix: `<ID>`
- Open gap and change register: `<ID>`

## Final release checklist

- [ ] No placeholder remains.
- [ ] Scope and applicability decisions have authorized owners and approvals.
- [ ] Every referenced document and record exists at its controlled revision.
- [ ] Source versions and currency-review dates are recorded.
- [ ] Process interactions and risk/postmarket feedback links are evidenced.
- [ ] Product-specific and jurisdiction-specific requirements were reviewed separately.
- [ ] Training and change impacts were approved.
- [ ] No certification, conformity, compliance, or readiness claim is made by this template.
- [ ] Final human approvals are recorded before the effective date.
