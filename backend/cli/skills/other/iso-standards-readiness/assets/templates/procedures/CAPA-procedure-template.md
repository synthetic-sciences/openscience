# CAPA Procedure Working Template

> **STATUS: DRAFT EXAMPLE — NOT APPROVED — NOT EVIDENCE OF CONFORMITY**
>
> Adapt this structure to approved processes, applicable requirements, product risk,
> and authorized roles. A completed template or passing script cannot establish
> compliance, close a CAPA, or replace RA/QA, management, legal, regulatory, auditor,
> or certification-body judgment.

## Controlled-document metadata

| Field | Entry |
|---|---|
| Document ID/revision | `<ID>` / `<revision>` |
| Owner | `<accountable role>` |
| Status | `draft` / `in-review` / `approved` |
| Effective date | `<YYYY-MM-DD after approval>` |
| Evidence repository | `<controlled location>` |
| Supersedes/change record | `<IDs>` |

| Approval role | Named approver | Status | Date | Approval evidence |
|---|---|---|---|---|
| Process owner | `<name/role>` | `pending` | `<date>` | `<ID>` |
| RA/QA | `<name/role>` | `pending` | `<date>` | `<ID>` |
| Authorized management | `<name/role>` | `pending` | `<date>` | `<ID>` |

## 1. Purpose and scope

- Controlled purpose: `<organization-specific statement>`
- Products, sites, processes, and records covered: `<scope>`
- Interfaces: complaints, audit, suppliers, nonconformity, risk, vigilance,
  design/production change, validation, training, and management review.
- Exclusions or interfaces outside this procedure: `<approved rationale/evidence>`

## 2. Roles and authority

| Role | Responsibility and decision authority | Escalation | Competence evidence | Approval |
|---|---|---|---|---|
| CAPA system owner | `<entry>` | `<entry>` | `<ID>` | `<ID>` |
| CAPA owner | `<entry>` | `<entry>` | `<ID>` | `<ID>` |
| Independent effectiveness reviewer | `<entry>` | `<entry>` | `<ID>` | `<ID>` |
| RA/QA reviewer | `<entry>` | `<entry>` | `<ID>` | `<ID>` |
| Closure approver | `<entry>` | `<entry>` | `<ID>` | `<ID>` |

## 3. CAPA intake and decision

Define controlled inputs and the approved criteria for opening, escalating, linking,
combining, or declining a CAPA. Do not use an arbitrary priority label as a substitute
for product/process risk and reportability review.

| Input | Owner | Decision method | Evidence | Status | Approval |
|---|---|---|---|---|---|
| Complaint/feedback | `<role>` | `<method>` | `<ID>` | `draft` | `<ID>` |
| Audit/nonconformity | `<role>` | `<method>` | `<ID>` | `draft` | `<ID>` |
| Supplier issue | `<role>` | `<method>` | `<ID>` | `draft` | `<ID>` |
| Trend/risk/postmarket signal | `<role>` | `<method>` | `<ID>` | `draft` | `<ID>` |

Each decision record must include:

- unique CAPA ID and source-event links;
- factual problem statement and known scope;
- correction/containment and evidence;
- product, patient/user, process, and regulatory/reportability impact review;
- decision owner, status, rationale, evidence, and approval.

## 4. Investigation and systemic extent

The record must define the method before drawing a conclusion and preserve the
evidence reviewed.

| Field | Required entry |
|---|---|
| Investigation owner/status | `<role>` / `draft` |
| Scope and plan | `<entry>` |
| Data and evidence IDs | `<IDs>` |
| Analysis method and rationale | `<entry>` |
| Root cause or justified conclusion | `<entry>` |
| Similar/systemic issue review | `<entry>` |
| Risk-file/design/supplier/process impacts | `<entry>` |
| Reviewer and approval evidence | `<role/ID>` |

Do not force a preferred root-cause method. Select and approve a method appropriate
to the evidence, complexity, and risk.

## 5. Action planning and change control

| Action ID | Description | Owner | Due date | Change/validation/training links | Implementation evidence | Status | Approval |
|---|---|---|---|---|---|---|---|
| `<ID>` | `<entry>` | `<role>` | `<date>` | `<IDs>` | `<IDs>` | `planned` | `<ID>` |

Actions must address the supported cause or risk, include objective acceptance
criteria, and route affected documents, software, validation, suppliers, products,
training, risk files, and postmarket controls through approved change control.

## 6. Effectiveness plan and review

Define the effectiveness plan before closure.

| Field | Required entry |
|---|---|
| Effectiveness owner | `<role>` |
| Independent reviewer | `<role>` |
| Objective acceptance criteria | `<measurable criteria>` |
| Baseline/comparator | `<entry>` |
| Data source and evidence IDs | `<IDs>` |
| Sample or observation window | `<risk-based rationale>` |
| Review date | `<YYYY-MM-DD>` |
| Result | `pending` / `effective` / `ineffective` |
| Conclusion and evidence | `<entry/IDs>` |
| Approval | `<approver/date/record ID>` |

**Fail-closed gate:** `pending`, insufficient data, or `ineffective` cannot support
closure. Re-open the investigation/action cycle or document authorized escalation.

## 7. Closure, cancellation, and extension

Closure requires:

- all actions implemented with evidence;
- approved effectiveness result of `effective`;
- linked risk, design, production, supplier, postmarket, document, validation, and
  training changes completed or explicitly dispositioned;
- complete source/version references;
- closure summary, date, owner, status, evidence, and authorized approval.

Cancellation or due-date changes require a documented rationale, risk/reportability
impact review, owner, status, evidence, and approval. Neither changes the need for
immediate safety or regulatory action when applicable.

## 8. Records, metrics, and management visibility

| Record/measure | Owner | Retention basis | Location | Review method | Evidence | Approval |
|---|---|---|---|---|---|---|
| CAPA record set | `<role>` | `<approved basis>` | `<location>` | `<method>` | `<ID>` | `<ID>` |
| Aging/overdue status | `<role>` | `<basis>` | `<location>` | `<method>` | `<ID>` | `<ID>` |
| Recurrence/effectiveness trend | `<role>` | `<basis>` | `<location>` | `<method>` | `<ID>` | `<ID>` |
| Management-review input | `<role>` | `<basis>` | `<location>` | `<method>` | `<ID>` | `<ID>` |

## Release checklist

- [ ] Placeholders are resolved.
- [ ] Interfaces to risk, complaints/vigilance, suppliers, design, production,
      validation, software, training, and change control are explicit.
- [ ] No fixed timeline is used without an approved risk/process basis.
- [ ] Effectiveness criteria are objective and approved before closure.
- [ ] Records carry owner, status, evidence, source/version, and approval fields.
- [ ] Authorized human approvers released the procedure.
- [ ] The procedure makes no compliance or certification claim.
