# Document and Record Control Procedure Working Template

> **STATUS: DRAFT EXAMPLE — NOT APPROVED — NO COMPLIANCE CLAIM**
>
> This structure is not a released procedure. It does not determine retention,
> regulatory applicability, conformity, or certification. Authorized management,
> RA/QA, legal/regulatory, process owners, and document control must approve the
> organization-specific controls. ISO publications are copyrighted; use an
> authorized copy and do not paste their text here.

## Controlled-document metadata

| Field | Entry |
|---|---|
| Document ID/revision | `<ID>` / `<revision>` |
| Owner | `<accountable role>` |
| Status | `draft` / `in-review` / `approved` |
| Effective date | `<YYYY-MM-DD after approval>` |
| Evidence repository | `<controlled location>` |
| Change/superseded record | `<IDs>` |

| Approval role | Named approver | Status | Date | Approval evidence |
|---|---|---|---|---|
| Process owner | `<name/role>` | `pending` | `<date>` | `<ID>` |
| RA/QA | `<name/role>` | `pending` | `<date>` | `<ID>` |
| System owner | `<name/role>` | `pending` | `<date>` | `<ID>` |

## 1. Purpose, scope, and interfaces

- Controlled documents covered: `<types, systems, sites, products>`
- Records covered: `<types, systems, sites, products>`
- External sources covered: standards, regulations, guidance, customer and supplier
  specifications, and product-specific sources.
- Interfaces: change control, training, validation, data integrity, cybersecurity,
  supplier controls, product files, complaints/CAPA, audit, and management review.

## 2. Roles and segregation of duties

| Role | Authority/responsibility | Independence or access restriction | Delegate | Evidence | Approval |
|---|---|---|---|---|---|
| Document owner | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<ID>` |
| Record owner | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<ID>` |
| Reviewer | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<ID>` |
| Approver | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<ID>` |
| System administrator | `<entry>` | `<entry>` | `<role>` | `<ID>` | `<ID>` |

## 3. Document lifecycle

| Stage | Required controls | Owner | Status | Evidence | Approval |
|---|---|---|---|---|---|
| Request/authoring | need, scope, source/version, author | `<role>` | `draft` | `<ID>` | `<ID>` |
| Review | technical, process, RA/QA, linked-document impact | `<role>` | `draft` | `<ID>` | `<ID>` |
| Approval/release | named authority, date, revision, effective date | `<role>` | `draft` | `<ID>` | `<ID>` |
| Distribution/use | access, point-of-use revision, copy status | `<role>` | `draft` | `<ID>` | `<ID>` |
| Change | rationale, impact, validation/training, linked updates | `<role>` | `draft` | `<ID>` | `<ID>` |
| Obsolescence | withdrawal, archive, retained-copy identification | `<role>` | `draft` | `<ID>` | `<ID>` |

Define approved rules for identifiers, revision schemes, emergency changes, printed
copies, translations, electronic signatures, and controlled exports. Do not assume
that a downloaded or printed file remains controlled.

## 4. Record lifecycle and data integrity

| Control | Organization-specific method | Owner | Status | Evidence | Approval |
|---|---|---|---|---|---|
| Creation/attribution | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Legibility/completeness | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Contemporaneous entry | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Corrections/audit trail | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Access/security | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Backup/recovery | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Retrieval | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |
| Retention/disposition | `<entry>` | `<role>` | `draft` | `<ID>` | `<ID>` |

Retention periods must cite an approved basis for each record type. This template
does not supply a universal period.

## 5. External source and version control

| Source ID | Publisher/title | Version/date | Authorized location | Applicability owner | Last currency review | Impact record | Status | Approval |
|---|---|---|---|---|---|---|---|---|
| `<ID>` | `<entry>` | `<entry>` | `<entry>` | `<role>` | `<date>` | `<ID>` | `review-due` | `<ID>` |

Required controls:

1. Obtain standards from an authorized source and preserve license restrictions.
2. Record the exact edition/version incorporated into each jurisdictional basis.
3. Monitor official publishers; do not rely on search snippets as controlled text.
4. Perform and approve impact assessment before changing QMS documents.
5. Distinguish ISO, FDA QMSR/eCFR, MDSAP, EU MDR/IVDR/MDCG, and product-specific
   sources rather than treating them as interchangeable.

## 6. Electronic systems and software validation

| System/use | Intended use | Risk basis | Access/audit-trail controls | Validation evidence | Change/revalidation trigger | Owner | Approval |
|---|---|---|---|---|---|---|---|
| `<system>` | `<entry>` | `<entry>` | `<entry>` | `<ID>` | `<entry>` | `<role>` | `<ID>` |

Do not release an electronic workflow until authorized owners approve intended use,
validation evidence, access roles, data migration, backup/recovery, and change
controls.

## 7. Change and training impact

Every change record should include:

- reason, affected products/sites/processes/documents/records;
- source/version and regulatory-impact review;
- risk, validation, software, supplier, and postmarket impacts;
- training population and completion evidence before effective use;
- implementation verification, owner, status, evidence, and approval.

## 8. Registers and audit evidence

| Register | Owner | Status | Location | Review frequency/basis | Evidence | Approval |
|---|---|---|---|---|---|---|
| Master document list | `<role>` | `draft` | `<location>` | `<basis>` | `<ID>` | `<ID>` |
| Record retention schedule | `<role>` | `draft` | `<location>` | `<basis>` | `<ID>` | `<ID>` |
| External source ledger | `<role>` | `draft` | `<location>` | `<basis>` | `<ID>` | `<ID>` |
| Access/role register | `<role>` | `draft` | `<location>` | `<basis>` | `<ID>` | `<ID>` |
| Training/change register | `<role>` | `draft` | `<location>` | `<basis>` | `<ID>` | `<ID>` |
| Obsolete/disposition log | `<role>` | `draft` | `<location>` | `<basis>` | `<ID>` | `<ID>` |

## Release checklist

- [ ] Scope includes documents, records, external sources, and electronic systems.
- [ ] Owners, statuses, evidence, source versions, and approvals are explicit.
- [ ] Access, integrity, retrieval, retention, disposition, and audit trails are defined.
- [ ] Change, validation, software, supplier, and training impacts are linked.
- [ ] No universal retention period or automatic applicability conclusion is asserted.
- [ ] No template or script result is described as compliance or certification.
- [ ] Required human approvals are complete before the effective date.
