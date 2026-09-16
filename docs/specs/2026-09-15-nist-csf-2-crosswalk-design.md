# NIST CSF 2.0 in Comp: design for enabling the framework and mapping it to the control library

Status: draft for review.
Branch: `revola/csf-2.0` (from `revola/self-host`).
Date: 2026-09-15.

## 1. Purpose

Make NIST CSF 2.0 selectable in this self-hosted Comp instance with every subcategory backed by controls, policies and evidence tasks, so that it works the way SOC 2 already does.
The same control library serves both frameworks, so evidence collected for one counts toward the other.

## 2. Sources and what is and is not claimed

Every factual statement in this document comes from one of the sources below, and the "Verification" section at the end gives the command that reproduces it.

| Source | What it is used for | How obtained |
|---|---|---|
| NIST, *The NIST Cybersecurity Framework (CSF) 2.0*, NIST CSWP 29, published 2024-02-26, DOI 10.6028/NIST.CSWP.29 | The framework itself. | https://csrc.nist.gov/pubs/cswp/29/the-nist-cybersecurity-framework-csf-20/final |
| NIST CSF 2.0 Reference Tool export (workbook, sheet `CSF 2.0`, change log "Final") | The verbatim text of all 6 Functions, 22 Categories and 106 Subcategories, plus NIST's Implementation Examples and Informative References (SP 800-53 Rev 5, ISO/IEC 27001:2022, CIS Controls v8, CCM v4, PCI DSS, and others). | https://csrc.nist.gov/extensions/nudp/services/json/csf/download?olirids=all, downloaded 2026-09-15, parsed into `.local/sources/csf-2.0-core.json`. The export also lists 79 CSF 1.1 subcategory ids marked `[Withdrawn: ...]`; those are excluded. |
| This repository, `packages/db/prisma/seed/` (branch `revola/self-host` at commit `8556a717e`) | Comp's control, policy and evidence-task templates and the existing framework-to-control relations. | Read directly. |

Explicitly not relied on:

- AICPA's "Mapping: 2017 Trust Services Criteria to NIST CSF" (aicpa-cima.com) targets CSF 1.1, not 2.0. No AICPA mapping to CSF 2.0 was found, so none is cited. Earlier conversation in this project described an AICPA TSC-to-CSF mapping without that qualifier; this document corrects it.
- Any third-party crosswalk (vendor blogs, SCF, etc.).

The mapping of subcategories to Comp controls (section 7) is engineering judgment.
Each row states the reason in terms of (a) the subcategory's official text and (b) the control template's own description as stored in the repo, and lists NIST's SP 800-53 Rev 5 informative references for that subcategory so a reviewer can check the mapping against an official anchor.
Nothing in the mapping is presented as an official NIST or AICPA position.

## 3. Verified current state

Numbers below were computed from the seed files on 2026-09-15 (commands in section 10).

- The seed contains a `FrameworkEditorFramework` row `frk_6820090a1653380dd386c5eb`, name `NIST CSF`, version `2.0`, `visible: false`.
- It has 106 `FrameworkEditorRequirement` rows whose ids, after parsing the `name` prefix, are exactly the 106 live CSF 2.0 subcategory ids (0 missing, 0 extra). Per Function: GV 31, ID 21, PR 22, DE 11, RS 13, RC 8, matching the official core.
- All 106 rows have `identifier = ""`; the subcategory id is embedded in `name` (for example `GV.OC-01 Organizational Context`); one row (`RS.AN-08`) has a trailing tab in `name`.
- 31 of the 106 `description` values differ from NIST's text. 30 differ only in hyphenation and dash characters (for example "risk-management" vs "risk management"). One (`GV.SC-05`) drops the words "other types of" from NIST's "contracts and other types of agreements". 38 rows use a category name that differs from NIST's (for example "Roles, Responsibilities & Authorities" vs "Roles, Responsibilities, and Authorities").
- There are 0 rows in `_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json` whose `B` is a CSF requirement id. SOC 2 (`frk_683f377429b8408d1c85f9bd`, visible) has 63 requirements and 121 such rows.
- The control library has 204 `FrameworkEditorControlTemplate` rows, 52 policy templates and 148 task templates. Several control names are duplicated (two "Risk Management", two "Physical & Environmental Security", two "Encrypted Data at Rest", three "Accountability and governance"), so this design references controls by id.
- Framework instantiation for an organization (`apps/api/src/frameworks/frameworks-upsert.helper.ts`) reads the framework's pinned `FrameworkVersion.manifest`, falling back to live editor tables only when no version exists. The seed (`packages/db/prisma/seed/seed.ts`, via `backfillFrameworkVersions`) publishes version `1.0.0` for any framework that has none. On this machine CSF therefore already has an empty `1.0.0` manifest; no `FrameworkInstance` references it.
- Policy and task links hang off the control template (`_FrameworkEditorControlTemplateToFrameworkEditorPolicyTemplate.json`, `..ToFrameworkEditorTaskTemplate.json`). Mapping a subcategory to a control therefore brings that control's policies and tasks into the framework manifest.

## 4. Scope

In scope:

1. Make the framework visible and correct its requirement rows to NIST's verbatim text.
2. Map all 106 subcategories to control templates.
3. Add the minimum new control and task templates needed so every subcategory has at least one control that carries at least one policy and one evidence task.
4. A reproducible generator and tests so the mapping is data, not a manual editor session.
5. Roll out on this machine and add CSF to the existing organization.

Out of scope:

- CSF Tiers, Profiles, or the Implementation Examples as separate data.
- Changing SOC 2 or any other framework's requirement-to-control mapping.
- Upstreaming to trycompai/comp.

## 5. Design

### 5.1 Crosswalk source of truth

New file `packages/db/prisma/seed/crosswalks/nist-csf-2.0.json`:

```json
{
  "frameworkId": "frk_6820090a1653380dd386c5eb",
  "source": "NIST CSF 2.0 Reference Tool export, downloaded 2026-09-15",
  "subcategories": [
    {
      "id": "GV.OC-01",
      "requirementId": "frk_rq_68201502a79c88a0e564e122",
      "controls": [{ "id": "frk_ct_...", "name": "Organizational Context & Mission" }],
      "rationale": "..."
    }
  ]
}
```

The `name` next to each control id is informational; the generator checks it against the template and fails on mismatch.

### 5.2 Generator

New script `packages/db/src/scripts/apply-csf-crosswalk.ts`, run with `bun run crosswalk:csf` from `packages/db`.
It:

1. Loads the crosswalk, the requirement file and the control file.
2. Rewrites the CSF entries of `relations/_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json` (rows whose `B` is one of the 106 CSF requirement ids), leaving every other row byte-for-byte unchanged, and sorts the CSF rows deterministically.
3. Rewrites the 106 CSF rows in `primitives/FrameworkEditorRequirement.json` with `identifier` = subcategory id, `name` = NIST category name, `description` = NIST subcategory text, `requirementFamily` = NIST Function name, `sortOrder` = position in NIST order (GV, ID, PR, DE, RS, RC; categories and subcategories in the order of the official core). Row ids are unchanged so the seed's upsert updates in place.
4. Sets `visible: true` on the framework row.

The NIST text used by step 3 is committed as `packages/db/prisma/seed/crosswalks/nist-csf-2.0-core.json` (the parsed export, 106 subcategories with Function and Category names and text, SP 800-53 references, ISO/IEC 27001:2022 references).
Implementation Examples are not committed; they are not needed at runtime.

### 5.3 New templates

Added to the primitives files with new prefixed-cuid ids (`frk_ct_`, `frk_tt_`) in the same style as existing rows.

Control templates (6):

| Name | Description | Policy templates linked (existing) | Task templates linked |
|---|---|---|---|
| Organizational Context & Mission | Document the organization's mission, internal and external stakeholders and their cybersecurity expectations, the critical services external parties depend on, and the outcomes and services the organization depends on, so that cybersecurity risk management is grounded in organizational context. | Information Security & Privacy Governance | Stakeholder Register / Interested Parties Log (existing); Organizational Context Statement (new) |
| Risk Appetite & Tolerance | Establish, communicate and maintain risk appetite and risk tolerance statements, the strategic direction on acceptable risk response options, and the treatment of strategic opportunities (positive risks) in cybersecurity risk discussions. | Risk Management | Risk Appetite Statement (new); Risk Analysis & Treatment Plan (existing) |
| Supply Chain Risk Management Program | Establish and operate a cybersecurity supply chain risk management program: strategy, objectives, policies and roles agreed by stakeholders; integration into enterprise risk management; supplier inclusion in incident planning; lifecycle-wide monitoring of supply chain security practices; and provisions for concluding supplier relationships. | Vendor & Third-Party Risk | Supplier Evaluation Records (existing); Supply Chain Risk Register (new) |
| Cybersecurity Strategy Oversight | Review cybersecurity risk management strategy outcomes and organizational risk management performance on a defined cadence, and adjust the strategy to cover changing requirements, risks and capabilities. | Information Security & Privacy Governance | Management Review Minutes (existing); Cybersecurity Strategy Review (new) |
| Incident & Recovery Communications | Maintain a stakeholder communication plan for incidents and recovery: who is notified, what is shared with designated internal and external stakeholders, how recovery progress is reported, and which approved methods and messaging are used for public updates. | Incident Response & Breach Notification | Stakeholder Communication Plan (new) |
| Technology Asset Lifecycle | Manage systems, hardware, software, services and data through acquisition, maintenance, replacement and removal, including secure disposal of hardware and media at end of life. | Secure Configuration & Hardening; Retention & Secure Disposal | Media Sanitization & Disposal Log (existing); Device List (existing) |

Task templates (6), all `automationStatus: MANUAL`:

| Name | Description | Frequency | Department |
|---|---|---|---|
| Organizational Context Statement | Maintain a statement of the organization's mission, key internal and external stakeholders and their cybersecurity expectations, critical services others depend on, and services the organization depends on. Review annually. | yearly | gov |
| Risk Appetite Statement | Maintain an approved risk appetite and risk tolerance statement, including the accepted risk response options and how strategic opportunities are considered. Review annually and after major changes. | yearly | gov |
| Supply Chain Risk Register | Maintain a register of suppliers ranked by criticality with their assessed cybersecurity risk, contract security requirements, incident-response involvement, and end-of-relationship provisions. | quarterly | gov |
| Cybersecurity Strategy Review | Record the periodic review of cybersecurity strategy outcomes and risk management performance, and any resulting strategy adjustments. | yearly | gov |
| Stakeholder Communication Plan | Maintain the incident and recovery communication plan: notification lists, designated internal and external stakeholders, recovery progress reporting, and approved methods for public updates. | yearly | gov |
| Threat Intelligence Review | Record the sources of cyber threat intelligence in use and the periodic review of received intelligence against the organization's assets and risks. | quarterly | it |

### 5.4 Links added to existing controls

Eight existing controls that the crosswalk uses have no policy or no task today.
Links are added so they are actionable.
Because policy and task links are global to the control, these additions also reach other frameworks that use the control when their next `FrameworkVersion` is published; that effect is listed so it is a conscious choice.

| Control (id suffix) | Added policy | Added task | Other frameworks using this control today |
|---|---|---|---|
| Continual Improvement & Corrective Action (`1f0b8445`) | Internal Audit Procedure | Corrective Action Reports | none (orphan) |
| Security Awareness & Training (`11233ece`) | Security & Privacy Awareness Training | - | HIPAA 2025 |
| Supplier & Third-Party Security (`ffb17d27`) | - | Supplier Evaluation Records | ISO 27001 2022 |
| Threat intelligence (`b777e529`) | - | Threat Intelligence Review (new) | PCI DSS Level 1, PCI v0 |
| Business Continuity & ICT Readiness (`c12ae932`) | - | Contingency Plan Testing & Revision | ISO 27001 2022 |
| Physical & Environmental Security (`0d85cc31`) | - | Facility Security Plan | ISO 27001 2022 |
| Human Resources Security (`c4afa186`) | Background Screening & On/Off-boarding | - | ISO 27001 2022 |
| Risk Management, ISO variant (`443cbf5b`) | - | Risk Analysis & Treatment Plan | ISO 27001 2022 |

No links are added to controls shared with SOC 2, so the SOC 2 manifest is unaffected.

### 5.5 Tests

Vitest in `packages/db` (new `packages/db/src/scripts/apply-csf-crosswalk.test.ts`), written before the generator:

1. Every one of the 106 official subcategory ids appears exactly once in the crosswalk, and every crosswalk id is an official id.
2. Every referenced control id exists in the control template file and its recorded name matches.
3. Every control referenced by the crosswalk has at least one policy link and at least one task link after this change.
4. Every new task template id referenced by a control link exists.
5. Running the generator against the committed files is a no-op (the committed relation and requirement files are already the generator's output). This fails CI on hand edits.
6. The generator does not touch any relation row for a non-CSF requirement (byte-for-byte comparison of the non-CSF subset before and after).
7. Requirement rows: `identifier` equals the subcategory id, `description` equals NIST text, `name` equals NIST category name, for all 106.

### 5.6 Rollout on this machine

1. Delete the CSF `FrameworkVersion` row with version `1.0.0` (verified unreferenced: no `FrameworkInstance.currentVersionId` points at it).
2. `cd packages/db && bun run db:seed`. Upserts update the 106 requirement rows, insert new templates and relations, and `backfillFrameworkVersions` publishes a fresh `1.0.0` manifest for CSF from the now-mapped editor tables. SOC 2 rows and the existing organization are untouched (upsert by id; no deletes).
3. In the app: Overview, Add Framework, NIST CSF 2.0.

Fresh installs need no special step: the seed produces the mapped manifest on first run.

### 5.7 Acceptance

- `FrameworkEditorFramework` CSF row: `visible = true`.
- The organization has a `FrameworkInstance` for CSF; its version manifest lists 106 requirements, each with at least one control.
- Counts of the organization's controls, policies and tasks increase by exactly the number of templates the org did not already have (6 new controls plus the previously unused existing ones the crosswalk introduces, their policies, and their tasks); no duplicates by template id.
- SOC 2 instance counts (63 requirements, 35 controls) unchanged.
- A control shared by both frameworks (for example Access Rights) shows the same evidence status under both.
- `bun run test` in `packages/db` passes; `bun run typecheck` passes.

## 6. Mapping principles

1. One to three controls per subcategory. Result: 42 subcategories map to one control, 62 to two, 2 to three; 172 links in total; 49 distinct controls (43 existing, 6 new).
2. Choose the control whose evidence demonstrates the outcome, not every control that touches the topic.
3. Prefer controls already shared by SOC 2, ISO 27001, PCI DSS and HIPAA over framework-specific ones, so evidence is reused.
4. Where nothing in the library produces the required artifact (a mission statement, an appetite statement, a supply chain program, a strategy review, a communications plan, a lifecycle process), add a control rather than mislabel an existing one.

## 7. Crosswalk

Each row: NIST's subcategory text (verbatim from the export), NIST's SP 800-53 Rev 5 informative references for that subcategory (from the same export), the Comp controls it maps to (id suffix for existing controls), and the rationale.
Quoted phrases in the rationale are the control template's `description` field in the repo.

<!-- BEGIN GENERATED CROSSWALK -->

#### GV.OC Organizational Context

> The circumstances - mission, stakeholder expectations, dependencies, and legal, regulatory, and contractual requirements - surrounding the organization's cybersecurity risk management decisions are understood

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **GV.OC-01** The organizational mission is understood and informs cybersecurity risk management | PM-11 | Organizational Context & Mission (new) | No existing control records the mission or its cybersecurity implications; the new control documents mission, stakeholders and dependencies (evidence: Organizational Context Statement). |
| **GV.OC-02** Internal and external stakeholders are understood, and their needs and expectations regarding cybersecurity risk management are understood and considered | PM-09, PM-18, PM-30, SR-03, SR-05, SR-06, SR-08 | Organizational Context & Mission (new) | Stakeholder identification is captured by the new control; the existing "Stakeholder Register / Interested Parties Log" task is reused as its evidence. |
| **GV.OC-03** Legal, regulatory, and contractual requirements regarding cybersecurity - including privacy and civil liberties obligations - are understood and managed | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PM-28, PS-01, PT-01, RA-01, SA-01, SC-01, SI-01, SR-01 | Legal, Regulatory & IP Compliance `7c8936fc` | Control "maintains an obligations register for applicable laws, regulations, contracts, and IP", which is the outcome of this subcategory. |
| **GV.OC-04** Critical objectives, capabilities, and services that external stakeholders depend on or expect from the organization are understood and communicated | CP-02(08), PM-08, PM-11, PM-30(01), RA-09 | Organizational Context & Mission (new); Business Continuity & ICT Readiness `c12ae932` | Criticality of services to external stakeholders is documented by the new control; "Business Continuity & ICT Readiness" adds the BIA ("Extends DR to include BIA, continuity strategy..."). |
| **GV.OC-05** Outcomes, capabilities, and services that the organization depends on are understood and communicated | PM-11, PM-30, RA-07, SA-09, SR-05 | Organizational Context & Mission (new); Supplier Security `a088e922` | Dependencies the organization relies on are recorded by the new control; external dependencies are supplier relationships, covered by "Ensure Security in Supplier Relationships". |

#### GV.RM Risk Management Strategy

> The organization's priorities, constraints, risk tolerance and appetite statements, and assumptions are established, communicated, and used to support operational risk decisions

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **GV.RM-01** Risk management objectives are established and agreed to by organizational stakeholders | PM-09, RA-07, SR-02 | Risk Management `b97c26af` | Risk management objectives are set by the program this control requires ("Maintain a Risk Management Program"; policy: Risk Management). |
| **GV.RM-02** Risk appetite and risk tolerance statements are established, communicated, and maintained | PM-09 | Risk Appetite & Tolerance (new) | No existing control produces appetite/tolerance statements; the new control does (evidence: Risk Appetite Statement). |
| **GV.RM-03** Cybersecurity risk management activities and outcomes are included in enterprise risk management processes | PM-03, PM-09, PM-30, RA-07, SA-24, SR-02 | Risk Management `b97c26af` | Inclusion of cybersecurity risk in enterprise risk processes is a property of the risk management program itself. |
| **GV.RM-04** Strategic direction that describes appropriate risk response options is established and communicated | PM-09, PM-28, PM-30, SR-02 | Risk Appetite & Tolerance (new); Risk Management `b97c26af` | Strategic direction on risk response options belongs with the appetite statement; response options are executed through the risk program. |
| **GV.RM-05** Lines of communication across the organization are established for cybersecurity risks, including risks from suppliers and other third parties | PM-09, PM-30 | Risk Management `b97c26af`; Supplier Security `a088e922` | Communication lines for risks are part of the risk program; the subcategory names suppliers explicitly, so supplier relationship security is included. |
| **GV.RM-06** A standardized method for calculating, documenting, categorizing, and prioritizing cybersecurity risks is established and communicated | PM-09, PM-18, PM-28, PM-30, RA-03 | Risk Management `443cbf5b` | This control is the "formal risk identification, assessment, treatment, and monitoring process, including risk register", i.e. the standardized method the subcategory requires. |
| **GV.RM-07** Strategic opportunities (i.e., positive risks) are characterized and are included in organizational cybersecurity risk discussions | PM-09, PM-18, PM-28, PM-30, RA-03 | Risk Appetite & Tolerance (new) | Positive risks (opportunities) are characterized alongside appetite and tolerance; no existing control covers them. |

#### GV.RR Roles, Responsibilities, and Authorities

> Cybersecurity roles, responsibilities, and authorities to foster accountability, performance assessment, and continuous improvement are established and communicated

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **GV.RR-01** Organizational leadership is responsible and accountable for cybersecurity risk and fosters a culture that is risk-aware, ethical, and continually improving | PM-02, PM-19, PM-23, PM-24, PM-29 | Management Security Accountability `d8f6bae2`; Organization Structure & Reporting Lines `53e31fa0` | "Ensure Management Addresses Security Responsibilities" and "Management establishes, with board oversight, structures, reporting lines, authorities, and responsibilities" together cover leadership accountability. |
| **GV.RR-02** Roles, responsibilities, and authorities related to cybersecurity risk management are established, communicated, understood, and enforced | PM-02, PM-13, PM-19, PM-23, PM-24, PM-29 | Security Governance Roles `88e2989a`; Organization Structure & Reporting Lines `53e31fa0` | "Define Security Roles and Responsibilities" plus the reporting-lines control cover establishment and communication of roles and authorities. |
| **GV.RR-03** Adequate resources are allocated commensurate with the cybersecurity risk strategy, roles, responsibilities, and policies | PM-03 | Management Security Accountability `d8f6bae2` | Resource allocation is a management accountability; the control's policy (Information Security & Privacy Governance) is where budget and staffing commitments are stated. |
| **GV.RR-04** Cybersecurity is included in human resources practices | PM-13, PS-01, PS-07, PS-09 | Personnel Security `4e63220f`; Human Resources Security `c4afa186` | "Screen onboard offboard securely" and "Owns pre-employment screening, confidentiality agreements, awareness training curriculum, and disciplinary handling" are cybersecurity in HR practices. |

#### GV.PO Policy

> Organizational cybersecurity policy is established, communicated, and enforced

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **GV.PO-01** Policy for managing cybersecurity risks is established based on organizational context, cybersecurity strategy, and priorities and is communicated and enforced | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PS-01, PT-01, RA-01, SA-01, SC-01, SI-01, SR-01 | Policy Compliance `624c59c1` | "Ensure Compliance with Security Policies and Standards"; its policies include Information Security & Privacy Governance and Policy Management & Exception Handling. |
| **GV.PO-02** Policy for managing cybersecurity risks is reviewed, updated, communicated, and enforced to reflect changes in requirements, threats, technology, and organizational mission | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PS-01, PT-01, RA-01, SA-01, SC-01, SI-01, SR-01 | Policy Compliance `624c59c1` | Policy review and update is governed by the same control's Policy Management & Exception Handling policy. |

#### GV.OV Oversight

> Results of organization-wide cybersecurity risk management activities and performance are used to inform, improve, and adjust the risk management strategy

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **GV.OV-01** Cybersecurity risk management strategy outcomes are reviewed to inform and adjust strategy and direction | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PM-09, PM-18, PM-30, PM-31, PS-01, PT-01, RA-01, RA-07, SA-01, SC-01, SI-01, SR-01, SR-06 | Cybersecurity Strategy Oversight (new); Internal Audit & Management Review `29676acb` | Strategy outcome review is the new control; "facilitates periodic management review of ISMS effectiveness" provides the review forum. |
| **GV.OV-02** The cybersecurity risk management strategy is reviewed and adjusted to ensure coverage of organizational requirements and risks | PM-09, PM-19, PM-30, PM-31, RA-07, SR-06 | Cybersecurity Strategy Oversight (new) | Adjusting the cybersecurity strategy for changing requirements and risks is the purpose of the new control (evidence: Cybersecurity Strategy Review). |
| **GV.OV-03** Organizational cybersecurity risk management performance is evaluated and reviewed for adjustments needed | PM-04, PM-06, RA-07, SR-06 | Internal Audit & Management Review `29676acb`; Cybersecurity Strategy Oversight (new) | Performance evaluation of risk management is delivered by internal audit and management review, reported into the strategy review. |

#### GV.SC Cybersecurity Supply Chain Risk Management

> Cyber supply chain risk management processes are identified, established, managed, monitored, and improved by organizational stakeholders

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **GV.SC-01** A cybersecurity supply chain risk management program, strategy, objectives, policies, and processes are established and agreed to by organizational stakeholders | PM-30, SR-02, SR-03 | Supply Chain Risk Management Program (new) | No existing control establishes a C-SCRM program, strategy, objectives and policies as a unit; the new control does (policy: Vendor & Third-Party Risk). |
| **GV.SC-02** Cybersecurity roles and responsibilities for suppliers, customers, and partners are established, communicated, and coordinated internally and externally | SR-02, SR-03, SR-05 | Supply Chain Risk Management Program (new); Security Governance Roles `88e2989a` | Supplier-facing roles are assigned within the program; "Define Security Roles and Responsibilities" covers internal role definition. |
| **GV.SC-03** Cybersecurity supply chain risk management is integrated into cybersecurity and enterprise risk management, risk assessment, and improvement processes | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PM-09, PM-18, PM-30, PM-31, PS-01, PT-01, RA-01, RA-03, RA-07, SA-01, SC-01, SI-01, SR-01, SR-02, SR-03 | Supply Chain Risk Management Program (new); Risk Management `b97c26af` | Integration of C-SCRM into enterprise risk management spans the program and the risk management program. |
| **GV.SC-04** Suppliers are known and prioritized by criticality | RA-09, SA-09, SR-06 | Supplier Security `a088e922`; Supply Chain Risk Management Program (new) | Knowing and prioritizing suppliers by criticality is the supplier register kept under supplier security and the program (evidence: Supply Chain Risk Register). |
| **GV.SC-05** Requirements to address cybersecurity risks in supply chains are established, prioritized, and integrated into contracts and other types of agreements with suppliers and other relevant third parties | SA-04, SA-09, SR-03, SR-05, SR-06, SR-10 | Supplier & Third-Party Security `ffb17d27`; Supplier Security `a088e922` | "Manages supplier due diligence, contract clauses, ongoing monitoring" covers integrating requirements into contracts. |
| **GV.SC-06** Planning and due diligence are performed to reduce risks before entering into formal supplier or other third-party relationships | SA-04, SA-09, SR-05, SR-06 | Supplier & Third-Party Security `ffb17d27`; Supplier Security `a088e922` | Due diligence before entering relationships is named in the control description ("supplier due diligence"). |
| **GV.SC-07** The risks posed by a supplier, their products and services, and other third parties are understood, recorded, prioritized, assessed, responded to, and monitored over the course of the relationship | RA-09, SA-04, SA-09, SR-03, SR-06 | Supplier Security `a088e922`; Risk Management `b97c26af` | Ongoing understanding and monitoring of supplier risk is supplier relationship security fed into the risk program. |
| **GV.SC-08** Relevant suppliers and other third parties are included in incident planning, response, and recovery activities | CP-01, IR-01, SA-04, SA-09, SR-02, SR-03, SR-08 | Supply Chain Risk Management Program (new); Security Incident Management `03d6bee8` | Including suppliers in incident planning, response and recovery is a program provision executed through "Establish an Incident Management Policy and Procedures". |
| **GV.SC-09** Supply chain security practices are integrated into cybersecurity and enterprise risk management programs, and their performance is monitored throughout the technology product and service life cycle | PM-09, PM-19, PM-28, PM-30, PM-31, RA-03, RA-07, SA-04, SA-09, SR-02, SR-03, SR-05, SR-06 | Supply Chain Risk Management Program (new) | Lifecycle-wide integration and monitoring of supply chain security practices is the program itself. |
| **GV.SC-10** Cybersecurity supply chain risk management plans include provisions for activities that occur after the conclusion of a partnership or service agreement | PM-31, RA-03, RA-05, RA-07, SA-04, SA-09, SR-02, SR-03, SR-05, SR-06 | Supply Chain Risk Management Program (new); Data Retention & Destruction `528353c1` | Post-relationship provisions (data return, access revocation) are program provisions; "Follow retention; securely dispose" handles data disposition. |

#### ID.AM Asset Management

> Assets (e.g., data, hardware, software, systems, facilities, services, people) that enable the organization to achieve business purposes are identified and managed consistent with their relative importance to organizational objectives and the organization's risk strategy

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **ID.AM-01** Inventories of hardware managed by the organization are maintained | CM-08, PM-05 | Asset Inventory `2f9df060` | "Maintain an Inventory of Information Assets" (evidence: Device List). |
| **ID.AM-02** Inventories of software, services, and systems managed by the organization are maintained | AC-20, CM-08, PM-05, SA-05, SA-09 | Asset Inventory `2f9df060` | Software, services and systems are information assets under the same inventory control. |
| **ID.AM-03** Representations of the organization's authorized network communication and internal and external network data flows are maintained | AC-04, CA-03, CA-09, PL-02, PL-08, PM-07 | Network Security `6306e23c`; Asset Inventory `2f9df060` | Network communication and data flow representations come from network security ("Enforce segmentation and firewalls") and the asset inventory. |
| **ID.AM-04** Inventories of services provided by suppliers are maintained | AC-20, SA-09, SR-02 | Supplier Security `a088e922`; Asset Inventory `2f9df060` | Inventories of supplier-provided services are the supplier register plus the asset inventory. |
| **ID.AM-05** Assets are prioritized based on classification, criticality, resources, and impact on the mission | RA-02, RA-03, RA-09 | Information Classification `de7b9c31`; Asset Inventory `2f9df060` | "Classify Information by Sensitivity" supplies the classification; the inventory records criticality and impact. |
| **ID.AM-07** Inventories of data and corresponding metadata for designated data types are maintained | CM-12, CM-13, SI-12 | Information Classification `de7b9c31`; Data Privacy `77b957f7` | Data inventories with classification are produced by information classification; personal data inventories by "Protect Privacy and Personal Data (PII)". |
| **ID.AM-08** Systems, hardware, software, services, and data are managed throughout their life cycles | CM-09, CM-13, MA-02, MA-06, PL-02, PM-22, PM-23, SA-03, SA-04, SA-08, SA-22, SI-12, SI-18, SR-05, SR-12 | Technology Asset Lifecycle (new); Change management `7fa58e13` | No existing control manages assets through their lifecycle end to end; the new control does, with "Apply Change Management for Information Systems" governing lifecycle changes. |

#### ID.RA Risk Assessment

> The cybersecurity risk to the organization, assets, and individuals is understood by the organization

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **ID.RA-01** Vulnerabilities in assets are identified, validated, and recorded | CA-02, CA-07, CA-08, RA-03, RA-05, SA-11(02), SA-15(07), SA-15(08), SI-04, SI-05 | Vulnerability Management `72aba39a` | "Manage both software and code vulnerabilities" identifies, validates and records vulnerabilities. |
| **ID.RA-02** Cyber threat intelligence is received from information sharing forums and sources | PM-15, PM-16, SI-05 | Threat intelligence `b777e529` | "Implement a Threat Intelligence Program" (evidence: new Threat Intelligence Review task). |
| **ID.RA-03** Internal and external threats to the organization are identified and recorded | PM-12, PM-16, RA-03, SI-05 | Risk Management `443cbf5b`; Threat intelligence `b777e529` | Threat identification and recording is part of formal risk identification, informed by threat intelligence. |
| **ID.RA-04** Potential impacts and likelihoods of threats exploiting vulnerabilities are identified and recorded | PM-09, PM-11, RA-02, RA-03, RA-08, RA-09 | Risk Management `443cbf5b` | Impact and likelihood are recorded in the risk register the control requires. |
| **ID.RA-05** Threats, vulnerabilities, likelihoods, and impacts are used to understand inherent risk and inform risk response prioritization | PM-16, RA-02, RA-03, RA-07 | Risk Management `443cbf5b`; Risk Management `b97c26af` | Combining threats, vulnerabilities, likelihoods and impacts into inherent risk and prioritization is risk assessment under both risk controls. |
| **ID.RA-06** Risk responses are chosen, prioritized, planned, tracked, and communicated | PM-09, PM-18, PM-30, RA-07 | Risk Management `443cbf5b` | Risk responses chosen and tracked are the "treatment plans" the control names. |
| **ID.RA-07** Changes and exceptions are managed, assessed for risk impact, recorded, and tracked | CA-07, CM-03, CM-04 | Change management `7fa58e13`; Policy Compliance `624c59c1` | Changes are managed and risk-assessed under change management; exceptions under Policy Management & Exception Handling. |
| **ID.RA-08** Processes for receiving, analyzing, and responding to vulnerability disclosures are established | RA-05 | Vulnerability Management `72aba39a`; Security Incident Management `03d6bee8` | Vulnerability disclosure intake is handled by vulnerability management, with incident procedures for response. |
| **ID.RA-09** The authenticity and integrity of hardware and software are assessed prior to acquisition and use | SA-04, SA-05, SA-10, SA-11, SA-15, SA-17, SI-07, SR-05, SR-06, SR-10, SR-11 | Supply Chain Risk Management Program (new); Secure SDLC Integration `096e6bb3` | Assessing hardware/software authenticity before acquisition is a supply chain program activity; software integrity in the pipeline sits with "Integrate Information Security into Project Management". |
| **ID.RA-10** Critical suppliers are assessed prior to acquisition | SR-06 | Supplier & Third-Party Security `ffb17d27`; Supplier Security `a088e922` | Pre-acquisition assessment of critical suppliers is supplier due diligence. |

#### ID.IM Improvement

> Improvements to organizational cybersecurity risk management processes, procedures and activities are identified across all CSF Functions

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **ID.IM-01** Improvements are identified from evaluations | AC-01, AT-01, AU-01, CA-01, CA-02, CA-05, CA-07, CA-08, CM-01, CP-01, CP-02, IA-01, IR-01, IR-04, IR-08, MA-01, MP-01, PE-01, PL-01, PL-02, PM-01, PS-01, PT-01, RA-01, RA-03, RA-05, RA-07, SA-01, SA-08, SA-11, SA-17(06), SC-01, SI-01, SI-02, SI-04, SR-01, SR-05 | Continual Improvement & Corrective Action `1f0b8445`; Internal Audit & Management Review `29676acb` | The control "Captures nonconformities identified through audits, incidents, management reviews, or day-to-day operations" and "drives corrective and preventive actions to completion", turning evaluation findings into improvements; audits come from "Plans and executes internal ISMS audits". |
| **ID.IM-02** Improvements are identified from security tests and exercises, including those done in coordination with suppliers and relevant third parties | AC-01, AT-01, AU-01, CA-01, CA-02, CA-05, CA-07, CA-08, CM-01, CP-01, CP-02, CP-04, IA-01, IR-01, IR-03, IR-04, IR-08, MA-01, MP-01, PE-01, PL-01, PL-02, PM-01, PM-04, PM-31, PS-01, PT-01, RA-01, RA-03, RA-05, RA-07, SA-01, SA-08, SA-11, SC-01, SI-01, SI-02, SI-04, SR-01, SR-05 | Continual Improvement & Corrective Action `1f0b8445`; Disaster Recovery Planning `ae323c9f` | Improvements from tests and exercises: DR testing ("Test DR; meet RTO/RPO") generates findings that continual improvement tracks. |
| **ID.IM-03** Improvements are identified from execution of operational processes, procedures, and activities | AC-01, AT-01, AU-01, CA-01, CA-02, CA-05, CA-07, CA-08, CM-01, CP-01, CP-02, IA-01, IR-01, IR-04, IR-08, MA-01, MP-01, PE-01, PL-01, PL-02, PM-01, PM-04, PM-31, PS-01, PT-01, RA-01, RA-03, RA-05, RA-07, SA-01, SA-04, SA-08, SA-11, SC-01, SI-01, SI-02, SI-04, SR-01, SR-05 | Continual Improvement & Corrective Action `1f0b8445` | Improvements from day-to-day operations are explicitly in the control description ("or day-to-day operations"). |
| **ID.IM-04** Incident response plans and other cybersecurity plans that affect operations are established, communicated, maintained, and improved | CP-02, IR-08, PL-02, SR-02 | Security Incident Management `03d6bee8`; Disaster Recovery Planning `ae323c9f`; Continual Improvement & Corrective Action `1f0b8445` | Incident response and recovery plans are owned by incident management and DR planning; their maintenance and improvement by continual improvement. |

#### PR.AA Identity Management, Authentication, and Access Control

> Access to physical and logical assets is limited to authorized users, services, and hardware and  managed commensurate with the assessed risk of unauthorized access

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **PR.AA-01** Identities and credentials for authorized users, services, and hardware are managed by the organization | AC-01, AC-02, AC-14, IA-01, IA-02, IA-03, IA-04, IA-05, IA-06, IA-07, IA-08, IA-09, IA-10, IA-11 | Access Rights `40bf3583`; Credential Management `e558a6f5` | "Manage User Access Rights Lifecycle" and "Protect Authentication Information" manage identities and credentials. |
| **PR.AA-02** Identities are proofed and bound to credentials based on the context of interactions | IA-12 | Access Rights `40bf3583`; Personnel Security `4e63220f` | Identity proofing happens at onboarding (evidence: Employee Verification under Personnel Security); binding to credentials is the access lifecycle. |
| **PR.AA-03** Users, services, and hardware are authenticated | AC-07, AC-12, IA-02, IA-03, IA-05, IA-07, IA-08, IA-09, IA-10, IA-11 | Credential Management `e558a6f5` | Authentication of users, services and hardware (evidence: 2FA, Secure Secrets). |
| **PR.AA-04** Identity assertions are protected, conveyed, and verified | IA-13 | Credential Management `e558a6f5` | Identity assertions are authentication information protected under this control. |
| **PR.AA-05** Access permissions, entitlements, and authorizations are defined in a policy, managed, enforced, and reviewed, and incorporate the principles of least privilege and separation of duties | AC-01, AC-02, AC-03, AC-05, AC-06, AC-10, AC-16, AC-17, AC-18, AC-19, AC-24, IA-13 | Access Rights `40bf3583`; Segregation of duties `ba048022` | Permissions with least privilege are access rights; separation of duties is "Implement Segregation of Duties". |
| **PR.AA-06** Physical access to assets is managed, monitored, and enforced commensurate with risk | PE-02, PE-03, PE-04, PE-05, PE-06, PE-08, PE-18, PE-19, PE-20 | Physical Access Control `676d93db` | "Control Physical Entry to Facilities" (evidence: Visitor Control, Office Access & Door Monitoring). |

#### PR.AT Awareness and Training

> The organization's personnel are provided with cybersecurity awareness and training so that they can perform their cybersecurity-related tasks

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **PR.AT-01** Personnel are provided with awareness and training so that they possess the knowledge and skills to perform general tasks with cybersecurity risks in mind | AT-02, AT-03 | Security Awareness & Training `11233ece`; Personnel Security `4e63220f` | "Implement a security awareness and training program" (evidence: Security Awareness Training); Personnel Security carries the Security & Privacy Awareness Training policy. |
| **PR.AT-02** Individuals in specialized roles are provided with awareness and training so that they possess the knowledge and skills to perform relevant tasks with cybersecurity risks in mind | AT-03 | Security Awareness & Training `11233ece` | Role-specific training is part of the same awareness and training program. |

#### PR.DS Data Security

> Data are managed consistent with the organization's risk strategy to protect the confidentiality, integrity, and availability of information

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **PR.DS-01** The confidentiality, integrity, and availability of data-at-rest are protected | CA-03, CP-09, MP-08, SC-04, SC-07, SC-12, SC-13, SC-28, SC-32, SC-39, SC-43, SI-03, SI-04, SI-07 | Encrypted Data at Rest `63fc79d9`; Information Classification `de7b9c31` | "The organization encrypts all production databases containing customer data at rest"; classification determines which data needs which protection. |
| **PR.DS-02** The confidentiality, integrity, and availability of data-in-transit are protected | AU-16, CA-03, SC-04, SC-07, SC-08, SC-11, SC-12, SC-13, SC-16, SC-40, SC-43, SI-03, SI-04, SI-07 | Secure Data Transfer `cc085ded` | "Protect Information in Transit" (evidence: TLS / HTTPS). |
| **PR.DS-10** The confidentiality, integrity, and availability of data-in-use are protected | AC-02, AC-03, AC-04, AU-09, AU-13, CA-03, CP-09, SA-08, SC-04, SC-07, SC-11, SC-13, SC-24, SC-32, SC-39, SC-40, SC-43, SI-03, SI-04, SI-07, SI-10, SI-16 | Data Masking `1446ce78`; Access Rights `40bf3583` | Data in use is protected by masking sensitive fields ("Hide sensitive fields") and by access rights limiting who can process it. |
| **PR.DS-11** Backups of data are created, protected, maintained, and tested | CP-06, CP-09 | Disaster Recovery Planning `ae323c9f` | Backups are created, protected and tested under DR planning (policies: Backup, Business Continuity & Disaster Recovery). |

#### PR.PS Platform Security

> The hardware, software (e.g., firmware, operating systems, applications), and services of physical and virtual platforms are managed consistent with the organization's risk strategy to protect their confidentiality, integrity, and availability

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **PR.PS-01** Configuration management practices are established and applied | CM-01, CM-02, CM-03, CM-04, CM-05, CM-06, CM-07, CM-08, CM-09, CM-10, CM-11 | Configuration & Patch Management `c0f3a3ae`; Change management `7fa58e13` | "Harden baselines; patch swiftly" is configuration management; changes to baselines go through change management. |
| **PR.PS-02** Software is maintained, replaced, and removed commensurate with risk | CM-11, MA-03(06), SA-10(01), SI-02, SI-07 | Configuration & Patch Management `c0f3a3ae`; Vulnerability Management `72aba39a` | Software maintenance/replacement/removal commensurate with risk is patching plus vulnerability management. |
| **PR.PS-03** Hardware is maintained, replaced, and removed commensurate with risk | CM-07(09), SA-10(03), SC-03(01), SC-39(01), SC-49, SC-51 | Technology Asset Lifecycle (new) | Hardware maintenance, replacement and removal is the new lifecycle control (evidence: Media Sanitization & Disposal Log, Device List). |
| **PR.PS-04** Log records are generated and made available for continuous monitoring | AU-02, AU-03, AU-06, AU-07, AU-11, AU-12, SA-15(13) | Security Logging `b4c2c4d8` | "Enable Logging of Security Events". |
| **PR.PS-05** Installation and execution of unauthorized software are prevented | CM-07(02), CM-07(04), CM-07(05), SC-34 | Endpoint Protection `669076cc`; Acceptable Use `776104c7` | "Protect Systems Against Malware" prevents unauthorized software execution; acceptable use prohibits unauthorized installation. |
| **PR.PS-06** Secure software development practices are integrated, and their performance is monitored throughout the software development life cycle | SA-03, SA-08, SA-10, SA-11, SA-15, SA-15(13), SA-17, SA-24 | Secure SDLC Integration `096e6bb3`; Vulnerability Management `72aba39a` | Secure development practices are the SDLC control; "code vulnerabilities" are covered by vulnerability management. |

#### PR.IR Technology Infrastructure Resilience

> Security architectures are managed with the organization's risk strategy to protect asset confidentiality, integrity, and availability, and organizational resilience

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **PR.IR-01** Networks and environments are protected from unauthorized logical access and usage | AC-03, AC-04, SC-04, SC-05, SC-07 | Network Security `6306e23c`; Remote-Work Security `2b35ca8f` | Protection from unauthorized logical access: segmentation and firewalls, plus "Implement Secure Remote Working Practices" for remote entry points. |
| **PR.IR-02** The organization's technology assets are protected from environmental threats | CP-02, PE-09, PE-10, PE-11, PE-12, PE-13, PE-14, PE-15, PE-18, PE-23 | Physical & Environmental Security `0d85cc31` | "environmental threat protections, cabling security, and secure siting of equipment". |
| **PR.IR-03** Mechanisms are implemented to achieve resilience requirements in normal and adverse situations | SA-08, SA-24, SC-06, SC-24, SC-36, SC-39, SI-13 | Business Continuity & ICT Readiness `c12ae932`; Disaster Recovery Planning `ae323c9f` | Resilience mechanisms in normal and adverse situations: continuity strategy and DR. |
| **PR.IR-04** Adequate resource capacity to ensure availability is maintained | CP-06, CP-07, CP-08, PM-03, PM-09 | Resource Capacity Management `b6ffd477` | "Perform Capacity Management for Resources". |

#### DE.CM Continuous Monitoring

> Assets are monitored to find anomalies, indicators of compromise, and other potentially adverse events

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **DE.CM-01** Networks and network services are monitored to find potentially adverse events | AC-02, AU-12, CA-07, CM-03, SC-05, SC-07, SI-04 | Security Monitoring & Detection `93773c1d`; Network Security `6306e23c` | "Central SIEM with alerting" monitors network events; network security provides the monitored boundary. |
| **DE.CM-02** The physical environment is monitored to find potentially adverse events | CA-07, PE-03, PE-06, PE-20 | Physical Access Control `676d93db` | Physical environment monitoring (evidence: Office Access & Door Monitoring, Visitor Control). |
| **DE.CM-03** Personnel activity and technology usage are monitored to find potentially adverse events | AC-02, AU-12, AU-13, CA-07, CM-10, CM-11 | Security Monitoring & Detection `93773c1d`; Utility Tool monitoring `5eb89158` | Personnel activity monitoring via SIEM; "Audits the execution of privileged program" covers privileged technology usage. |
| **DE.CM-06** External service provider activities and services are monitored to find potentially adverse events | CA-07, PS-07, SA-04, SA-09, SI-04 | Supplier Security `a088e922`; Security Monitoring & Detection `93773c1d` | Monitoring external service providers combines supplier oversight with monitoring of their activity in the environment. |
| **DE.CM-09** Computing hardware and software, runtime environments, and their data are monitored to find potentially adverse events | AC-04, AC-09, AU-12, CA-07, CM-03, CM-06, CM-10, CM-11, SC-34, SC-35, SI-04, SI-07 | Security Monitoring & Detection `93773c1d`; Endpoint Protection `669076cc`; Security Logging `b4c2c4d8` | Hardware, software and runtime monitoring: SIEM, endpoint anti-malware and security event logging. |

#### DE.AE Adverse Event Analysis

> Anomalies, indicators of compromise, and other potentially adverse events are analyzed to characterize the events and detect cybersecurity incidents

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **DE.AE-02** Potentially adverse events are analyzed to better understand associated activities | AU-06, CA-07, IR-04, SI-04 | Security Monitoring & Detection `93773c1d`; Security Incident Management `03d6bee8` | Analysis of potentially adverse events happens in monitoring, escalating into incident procedures. |
| **DE.AE-03** Information is correlated from multiple sources | AU-06, CA-07, IR-04, IR-05, IR-08, PM-16, SI-04 | Security Monitoring & Detection `93773c1d` | Correlation across sources is what a "Central SIEM" does. |
| **DE.AE-04** The estimated impact and scope of adverse events are understood | PM-09, PM-11, PM-18, PM-28, PM-30 | Security Incident Management `03d6bee8` | Impact and scope estimation is part of incident handling procedures. |
| **DE.AE-06** Information on adverse events is provided to authorized staff and tools | IR-04, PM-15, PM-16, RA-03, RA-04, RA-10 | Security Monitoring & Detection `93773c1d`; Security Incident Management `03d6bee8` | Providing adverse-event information to staff and tools is alerting plus incident notification procedures. |
| **DE.AE-07** Cyber threat intelligence and other contextual information are integrated into the analysis | PM-16, RA-03, RA-10 | Threat intelligence `b777e529`; Security Monitoring & Detection `93773c1d` | Threat intelligence is integrated into analysis by the threat intelligence program and SIEM. |
| **DE.AE-08** Incidents are declared when adverse events meet the defined incident criteria | IR-04, IR-08 | Security Incident Management `03d6bee8` | Incident declaration criteria live in the incident management policy and procedures. |

#### RS.MA Incident Management

> Responses to detected cybersecurity incidents are managed

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **RS.MA-01** The incident response plan is executed in coordination with relevant third parties once an incident is declared | IR-06, IR-07, IR-08, SR-03, SR-08 | Security Incident Management `03d6bee8` | Executing the incident response plan with third parties is incident management (evidence: Incident Response). |
| **RS.MA-02** Incident reports are triaged and validated | IR-04, IR-05, IR-06 | Security Incident Management `03d6bee8` | Triage and validation are incident procedures. |
| **RS.MA-03** Incidents are categorized and prioritized | IR-04, IR-05, IR-06 | Security Incident Management `03d6bee8` | Categorization and prioritization are incident procedures. |
| **RS.MA-04** Incidents are escalated or elevated as needed | IR-04, IR-05, IR-06, IR-07 | Security Incident Management `03d6bee8` | Escalation is an incident procedure. |
| **RS.MA-05** The criteria for initiating incident recovery are applied | IR-04, IR-08 | Security Incident Management `03d6bee8`; Disaster Recovery Planning `ae323c9f` | Criteria for initiating recovery bridge incident procedures and DR planning. |

#### RS.AN Incident Analysis

> Investigations are conducted to ensure effective response and support forensics and recovery activities

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **RS.AN-03** Analysis is performed to establish what has taken place during an incident and the root cause of the incident | AU-07, IR-04, SI-02(07) | Security Incident Management `03d6bee8`; Continual Improvement & Corrective Action `1f0b8445` | Root-cause analysis: "performs root-cause analysis" is in the continual improvement control; the incident procedure triggers it. |
| **RS.AN-06** Actions performed during an investigation are recorded, and the records' integrity and provenance are preserved | AU-07, IR-04, IR-06 | Security Incident Management `03d6bee8`; Security Logging `b4c2c4d8` | Recording investigation actions with integrity relies on incident procedures and security event logging. |
| **RS.AN-07** Incident data and metadata are collected, and their integrity and provenance are preserved | AU-07, IR-04, IR-06 | Security Logging `b4c2c4d8`; Security Incident Management `03d6bee8` | Incident data collection with preserved integrity is logging plus incident handling. |
| **RS.AN-08** An incident's magnitude is estimated and validated | IR-04, IR-08, RA-03, RA-07 | Security Incident Management `03d6bee8` | Magnitude estimation is part of incident handling. |

#### RS.CO Incident Response Reporting and Communication

> Response activities are coordinated with internal and external stakeholders as required by laws, regulations, or policies

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **RS.CO-02** Internal and external stakeholders are notified of incidents | IR-04, IR-06, IR-07, SR-03, SR-08 | Incident & Recovery Communications (new); Security Incident Management `03d6bee8` | Stakeholder notification is the new communications control (evidence: Stakeholder Communication Plan), invoked by incident procedures (policy: Incident Response & Breach Notification). |
| **RS.CO-03** Information is shared with designated internal and external stakeholders | IR-04, IR-06, IR-07, SR-03, SR-08 | Incident & Recovery Communications (new); Regulatory Liaison `3fa5b7bc` | Sharing with designated external stakeholders includes authorities ("Maintain Contact with Authorities"). |

#### RS.MI Incident Mitigation

> Activities are performed to prevent expansion of an event and mitigate its effects

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **RS.MI-01** Incidents are contained | IR-04 | Security Incident Management `03d6bee8` | Containment is an incident procedure. |
| **RS.MI-02** Incidents are eradicated | IR-04 | Security Incident Management `03d6bee8`; Vulnerability Management `72aba39a` | Eradication is an incident procedure; removing the exploited weakness is vulnerability management. |

#### RC.RP Incident Recovery Plan Execution

> Restoration activities are performed to ensure operational availability of systems and services affected by cybersecurity incidents

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **RC.RP-01** The recovery portion of the incident response plan is executed once initiated from the incident response process | CP-10, IR-04, IR-08 | Disaster Recovery Planning `ae323c9f`; Security Incident Management `03d6bee8` | Executing the recovery portion of the plan is DR planning triggered by incident management. |
| **RC.RP-02** Recovery actions are selected, scoped, prioritized, and performed | CP-10, IR-04, IR-08 | Disaster Recovery Planning `ae323c9f`; Business Continuity & ICT Readiness `c12ae932` | Selecting and prioritizing recovery actions uses DR plans and the continuity strategy/BIA. |
| **RC.RP-03** The integrity of backups and other restoration assets is verified before using them for restoration | CP-02, CP-04, CP-09 | Security Incident Management `03d6bee8`; Disaster Recovery Planning `ae323c9f` | Backup integrity verification before use (evidence: Backup Restoration Test, linked to Security Incident Management) within DR. |
| **RC.RP-04** Critical mission functions and cybersecurity risk management are considered to establish post-incident operational norms | IR-01, IR-08, PM-08, PM-09, PM-11 | Business Continuity & ICT Readiness `c12ae932`; Disaster Recovery Planning `ae323c9f` | Post-incident operational norms derive from the BIA/continuity strategy and DR objectives (RTO/RPO). |
| **RC.RP-05** The integrity of restored assets is verified, systems and services are restored, and normal operating status is confirmed | CP-10 | Disaster Recovery Planning `ae323c9f`; Security Incident Management `03d6bee8` | Restoration and confirmation of normal operations is DR execution closed out by incident management. |
| **RC.RP-06** The end of incident recovery is declared based on criteria, and incident-related documentation is completed | IR-04, IR-08 | Security Incident Management `03d6bee8`; Continual Improvement & Corrective Action `1f0b8445` | Declaring recovery complete and finishing documentation is incident closure; "lessons learned" feed continual improvement. |

#### RC.CO Incident Recovery Communication

> Restoration activities are coordinated with internal and external parties

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 r5) | Comp controls | Rationale |
|---|---|---|---|
| **RC.CO-03** Recovery activities and progress in restoring operational capabilities are communicated to designated internal and external stakeholders | IR-04, IR-06, SR-08 | Incident & Recovery Communications (new); Disaster Recovery Planning `ae323c9f` | Recovery progress communication is the new communications control, exercised during DR. |
| **RC.CO-04** Public updates on incident recovery are shared using approved methods and messaging | CP-02, IR-04 | Incident & Recovery Communications (new) | Public updates via approved methods are the external-communication half of the new control. |
<!-- END GENERATED CROSSWALK -->

## 8. Risks and open points

- The mapping is judgment, not a standard. A reviewer who disagrees with a row edits the crosswalk JSON and re-runs the generator; nothing else changes.
- "Security Incident Management" is mapped 23 times (all of RS plus parts of DE and RC). That is faithful to CSF's structure, where Respond is one control family in most implementations, but it means one control's status dominates three Functions. Splitting it into finer controls is possible later without changing this design.
- Adding links to the eight existing controls in 5.4 changes the ISO 27001, PCI and HIPAA manifests on their next publish. Those frameworks are not used by this organization today.
- The `RISK_ISO` and `RISK` controls are both named "Risk Management" in the UI. The crosswalk uses both deliberately (program vs. formal process), and the UI shows their different descriptions.

## 9. Self-review record

Checked before requesting external review:

- Placeholder scan: no TBD/TODO; all ids resolve (generator validation passes).
- Consistency: counts in section 6 are produced by the generator from the same data as section 7.
- Scope: one implementation plan; no decomposition needed.
- Ambiguity: "identifier"/"name" semantics fixed to match SOC 2 rows; rollout step 1 is explicit about deleting only the unreferenced CSF `1.0.0` version.
- Sources: every number in section 3 has a command in section 10; every subcategory string in section 7 is copied from the export by the generator, not typed.

## 10. Verification commands

Run from the repository root.

```bash
# Official core: 106 live subcategories, per-Function counts
python3 -c "import json,collections; d=json.load(open('.local/sources/csf-2.0-core.json')); s=d['subcategories']; print(len(s), dict(collections.Counter(x['function'] for x in s)))"

# Seed CSF rows: count, empty identifiers, ids match official
python3 -c "
import json,re
r=[x for x in json.load(open('packages/db/prisma/seed/primitives/FrameworkEditorRequirement.json')) if x['frameworkId']=='frk_6820090a1653380dd386c5eb']
ids={re.match(r'^([A-Z]{2}\.[A-Z]{2}-\d\d)',x['name']).group(1) for x in r}
off={x['id'] for x in json.load(open('.local/sources/csf-2.0-core.json'))['subcategories']}
print(len(r), sum(1 for x in r if x['identifier']==''), ids==off)"

# CSF has zero control links today; SOC 2 has 121
python3 -c "
import json
req=json.load(open('packages/db/prisma/seed/primitives/FrameworkEditorRequirement.json'))
cr=json.load(open('packages/db/prisma/seed/relations/_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json'))
csf={x['id'] for x in req if x['frameworkId']=='frk_6820090a1653380dd386c5eb'}; soc={x['id'] for x in req if x['frameworkId']=='frk_683f377429b8408d1c85f9bd'}
print(sum(1 for x in cr if x['B'] in csf), sum(1 for x in cr if x['B'] in soc))"

# Unreferenced CSF FrameworkVersion on this machine
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d comp -Atc "select v.id, v.version, (select count(*) from \"FrameworkInstance\" i where i.\"currentVersionId\"=v.id) from \"FrameworkVersion\" v where v.\"frameworkId\"='frk_6820090a1653380dd386c5eb';"

# Crosswalk validation and statistics (source of the numbers in section 6)
python3 .local/gen-csf-spec.py
```
