# NIST CSF 2.0 in Comp: design for enabling the framework and mapping it to the control library

Status: revision 3, for review.
Branch: `revola/csf-2.0` (from `revola/self-host`).
Date: 2026-09-15.
Revision 1 was reviewed adversarially (Codex, read-only against the sources below); revision 2 incorporated the 17 findings and was re-reviewed; revision 3 addresses the 7 findings still open after that pass plus the review's new items. Both rounds are summarized in section 11.

## 1. Purpose

Make NIST CSF 2.0 selectable in this self-hosted Comp instance with every subcategory backed by controls, policies and evidence tasks, so that it works the way SOC 2 already does.
The same control library serves both frameworks, so evidence collected for one counts toward the other.

## 2. Sources and what is and is not claimed

Every factual statement in this document comes from one of the sources below, and section 10 gives the command that reproduces it.

| Source | Used for | How obtained |
|---|---|---|
| NIST, *The NIST Cybersecurity Framework (CSF) 2.0*, NIST CSWP 29, published 2024-02-26, DOI 10.6028/NIST.CSWP.29 | The framework itself. | https://csrc.nist.gov/pubs/cswp/29/the-nist-cybersecurity-framework-csf-20/final |
| NIST CSF 2.0 Reference Tool export (workbook `.local/sources/csf-2.0-core.xlsx`, sheet `CSF 2.0`, change log "Final") | Verbatim text of all 6 Functions, 22 Categories and 106 Subcategories, plus NIST's Implementation Examples and Informative References. | https://csrc.nist.gov/extensions/nudp/services/json/csf/download?olirids=all, downloaded 2026-09-15. Parsed into `.local/sources/csf-2.0-core.json`; the workbook is primary and the JSON derived. The export also lists 79 CSF 1.1 subcategory ids marked `[Withdrawn: ...]`; those are excluded. SP 800-53 references are the union of the export's "Rev 5.1.1" and "Rev 5.2.0" entries, including family-level entries such as `PT`. |
| This repository, `packages/db/prisma/seed/` and the code files named in section 3 (branch `revola/self-host` at commit `8556a717e`) | Comp's templates, relations, seed and framework-publishing behaviour. | Read directly. |
| Database snapshot `.local/sources/db-state-2026-09-15.txt` | The state of this machine's database that the rollout depends on. | Query output saved 2026-09-16 (UTC timestamp in the file); queries in section 10. |

This design does not rely on an AICPA crosswalk and makes no claim about the availability or scope of AICPA mappings.
No third-party crosswalk is used.

The mapping of subcategories to Comp controls (section 7) is engineering judgment.
Each row names the parent control(s), quotes the control description, policy clause or task description that supports the choice, names the evidence task, and is marked "Judgment mapping." whenever the outcome is not stated by a mapped control's own description (including rows where a linked task or policy, rather than the control, carries it).
The generator checks every quoted span as an exact, case-sensitive substring of a text that belongs to a mapped control: its name or description, or the name or text of a policy or task linked to it globally or through a CSF-scoped link, or a new template's definition.
NIST's SP 800-53 Rev 5 informative references are listed per row as an official anchor for reviewers.
Nothing in the mapping is presented as an official NIST position.

## 3. Verified current state

Computed on 2026-09-15 from the seed files and the database snapshot (commands in section 10).

Seed data:

- `FrameworkEditorFramework` row `frk_6820090a1653380dd386c5eb`, name `NIST CSF`, version `2.0`, `visible: false`.
- 106 `FrameworkEditorRequirement` rows whose ids, parsed from the `name` prefix, are exactly the 106 live CSF 2.0 subcategory ids (0 missing, 0 extra). Per Function: GV 31, ID 21, PR 22, DE 11, RS 13, RC 8, matching the official core.
- All 106 rows have `identifier = ""`. 51 `name` values end with a tab character. 53 `description` values have leading or trailing whitespace.
- Raw comparison: 77 of 106 `description` values differ from NIST's text. After trimming whitespace and normalizing curly quotes: 31 differ. After additionally normalizing hyphens and dashes: 1 differs, `GV.SC-05`, where the seed drops "other types of" from NIST's "contracts and other types of agreements". 38 rows use a category name in `name` that differs from NIST's after trimming (for example "Roles, Responsibilities & Authorities" vs "Roles, Responsibilities, and Authorities").
- 0 rows in `_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json` have a CSF requirement id as `B`. SOC 2 (`frk_683f377429b8408d1c85f9bd`, visible) has 63 requirements, 121 such rows and 35 distinct controls.
- 204 `FrameworkEditorControlTemplate` rows, 52 policy templates, 148 task templates. Duplicate names exist (two "Risk Management", two "Physical & Environmental Security", two "Encrypted Data at Rest", two "Scope & Governance" with identical descriptions, three "Accountability and governance"; task "Management Review Minutes" exists twice, one for an ISMS and one for a QMS). This design references every control, policy and task by id.

Code behaviour:

- Organization framework structure (`apps/api/src/frameworks/frameworks-upsert.helper.ts`, `frameworks-source-loader.helper.ts`) is built, for a framework being added, from that framework's latest published `FrameworkVersion` (ordered by `publishedAt` descending), and the new instance is pinned to it; when no version exists it falls back to live editor tables read through the framework-scoped link tables. Adding a framework also connects the instantiated tasks and policies to the organization's controls through the organization-level relations (`_ControlToTask`, `_ControlToPolicy`), which are shared across the organization's frameworks.
- The normal publish path (`apps/api/src/framework-editor-versions/framework-manifest-builder.ts`) reads policy, task and document-type links from `FrameworkEditorControlPolicyTemplateLink`, `FrameworkEditorControlTaskTemplateLink` and `FrameworkEditorControlDocumentTypeLink` filtered by `frameworkId`, orders requirements by `sortOrder`, and includes `requirementFamily`, `sortOrder`, `controlFamily` and `documentTypes` in the manifest.
- The seed's `backfillFrameworkVersions` (`packages/db/src/scripts/backfill-framework-versions.ts`) attempts to create version `1.0.0` for every framework, swallowing the unique-constraint error where one exists, builds that manifest from the global `_FrameworkEditorControlTemplateTo*` relations, includes only `id`, `identifier`, `name` and `description` per requirement, and sets `currentVersionId` on any `FrameworkInstance` that has none.
- The scoped link tables are populated only by migration `20260513153000_backfill_framework_scoped_control_links`, from manifests where versions exist and from the global relations otherwise, at migration time. The seed does not populate them.
- `packages/db/prisma/seed/seed.ts` upserts every primitives row by id (the only load-order rule is that `FrameworkEditorFramework.json` goes first), connects relation rows (never disconnects), then runs `backfillFrameworkVersions` and `backfillFrameworkScopedLinks`. The latter fills instance-level links (`FrameworkControlPolicyLink`, `FrameworkControlTaskLink`, `FrameworkControlDocumentTypeLink`) for every existing `FrameworkInstance` from the organization-level relations, insert-if-missing; it does not consult the instance's pinned manifest.
- `FrameworkVersion` is referenced by `FrameworkInstance.currentVersionId` and by `FrameworkSyncOperation.fromVersionId` / `toVersionId`.

Database on this machine (snapshot):

- CSF has one `FrameworkVersion`, `fvr_6aa8572300dc0104dcff375b`, version `1.0.0`, manifest with 106 requirements and 0 controls; 0 `FrameworkInstance` rows reference it; 0 `FrameworkSyncOperation` rows reference it.
- The organization has one `FrameworkInstance` (SOC 2, pinned to a version).
- All three scoped editor link tables are empty (0, 0, 0), because the migration ran before the seed. Consequently a normal publish from the framework editor would currently produce controls with no policies or tasks for every framework, including SOC 2. SOC 2 works only because its `1.0.0` manifest came from the seed backfill, which reads the global relations.
- Instance-level links: 63 `FrameworkControlPolicyLink`, 76 `FrameworkControlTaskLink`, 9 `FrameworkControlDocumentTypeLink`. SOC 2 (`SOC 2 1`) has exactly one version, `1.0.0`, whose manifest has 63 requirements and 35 controls referencing 25 distinct policy ids and 26 distinct task ids; the organization's SOC 2 instance is pinned to it.

## 4. Scope

In scope:

1. Make the framework visible and replace its requirement rows' text with NIST's verbatim text.
2. Map all 106 subcategories to control templates.
3. Add the new control and task templates needed so every subcategory has at least one control that carries at least one policy and one evidence task relevant to the outcome.
4. Populate the framework-scoped editor links so the normal publish path and the seed backfill produce the same manifest, for every framework.
5. A generator, a reconciliation script and tests so the mapping is data.
6. Roll out on this machine and add CSF to the existing organization.

Out of scope:

- CSF Tiers, Profiles, or Implementation Examples as separate data.
- Changing any other framework's requirement-to-control mapping or its policy/task links.
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
      "controls": [{ "id": "frk_ct_69e6766bd8ca18f572d4c34f", "name": "Scope & Governance" }],
      "rationale": "..."
    }
  ],
  "scopedLinks": {
    "policies": [{ "controlTemplateId": "frk_ct_...", "policyTemplateId": "frk_pt_..." }],
    "tasks": [{ "controlTemplateId": "frk_ct_...", "taskTemplateId": "frk_tt_..." }]
  }
}
```

Every id is checked against the template files and the recorded `name` must equal the template's name exactly.

The parsed NIST core used for requirement text is committed as `packages/db/prisma/seed/crosswalks/nist-csf-2.0-core.json` (106 subcategories with Function and Category names and text, SP 800-53 and ISO/IEC 27001:2022 references).
Implementation Examples are not committed.

### 5.2 Generator (`packages/db/src/scripts/apply-csf-crosswalk.ts`, `bun run crosswalk:csf`)

1. Rewrites the CSF rows of `relations/_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json` (rows whose `B` is a CSF requirement id), leaving all other rows byte-for-byte unchanged, sorted deterministically.
2. Rewrites the 106 CSF rows of `primitives/FrameworkEditorRequirement.json` in place (same ids): `identifier` = subcategory id, `name` = NIST category name, `description` = NIST subcategory text, `requirementFamily` = NIST Function name, `sortOrder` = position in the official order.
3. Sets `visible: true` on the framework row.

It does not write scoped-link primitives; the scoped links are applied by the seed step in 5.3 directly from the crosswalk file, because the generic primitives loader has no dependency ordering beyond `FrameworkEditorFramework.json` first, and id-based upserts would collide with rows that already exist under another id for the same `(frameworkId, controlTemplateId, policyTemplateId)` composite key.

### 5.3 Seed, manifest builder and backfill changes

One manifest builder.
`buildManifestForFramework` and the `FrameworkManifest` types move from `apps/api/src/framework-editor-versions/` and `apps/api/src/frameworks/framework-versioning/manifest.types.ts` into `packages/db/src/framework-manifest/` and are re-exported from `@trycompai/db`; the API imports them from there.
`backfillFrameworkVersions` uses the same function, so a backfilled `1.0.0` manifest and a manifest published from the framework editor are produced by one implementation (policy, task and document-type ids from the scoped links; `requirementFamily`, `sortOrder`, `controlFamily`, requirement order).
Existing stored versions are never rewritten by the backfill; only missing `1.0.0` rows are created.

Seed step `syncFrameworkScopedEditorLinks()`, added to `seed.ts` after relations and before `backfillFrameworkVersions` (so all templates and relations exist):

1. For every framework, insert scoped policy, task and document-type link rows derived from the global relations for the controls mapped to that framework's requirements, with `ON CONFLICT DO NOTHING` on the composite unique keys. This is the migration's fallback query with its "frameworks without a published version" filter removed. Fork decision: in this self-hosted fork the scoped tables are only ever populated by this step, so for every framework except CSF the scoped set is the global union, which is exactly what their backfilled `1.0.0` manifests were built from. If upstream data with curated scoped links is ever imported, this step must be revisited.
2. For CSF only, the crosswalk file is authoritative: set each CSF requirement's `controlTemplates` to the crosswalk's ids (`set`, so removed mappings are removed); compute the CSF scoped set as the global links of the mapped controls plus the CSF-only links in 5.4; delete CSF scoped rows not in that set; insert missing rows keyed by the composite unique. Re-running the seed after editing the crosswalk therefore reconciles the database, and no separate reconciliation script is needed.

Instance-level backfill.
`backfillFrameworkScopedLinks` in `seed.ts` is changed to derive an instance's links from its pinned version's manifest (each manifest control's `policyIds`, `taskIds`, `documentTypes`, resolved to the organization's rows by template id) when `currentVersionId` is set, and to keep today's organization-level fallback only for unpinned instances.
Without this change, adding CSF to the organization connects CSF-scoped tasks to the organization's shared controls (for example Risk Management), and the next seed run would copy those into the SOC 2 instance's links.

### 5.4 New templates and CSF-scoped links

New control templates (5), with new `frk_ct_` ids:

| Name | Description | Policies (existing, by id) | Tasks |
|---|---|---|---|
| Critical Services & Dependencies | Identify and communicate the critical objectives, capabilities and services that external stakeholders depend on or expect from the organization, and the outcomes, capabilities and services the organization depends on, so that criticality informs cybersecurity risk management and continuity planning. | Information Security & Privacy Governance `frk_pt_685e3f7b4ebcb27b60c51434` | Critical Services & Dependencies Statement (new) |
| Risk Appetite & Tolerance | Establish, communicate and maintain risk appetite and risk tolerance statements, the strategic direction on acceptable risk response options, and the treatment of strategic opportunities (positive risks) in cybersecurity risk discussions. | Risk Management `frk_pt_685e3fc75bd72cd0745dc5d1` | Risk Appetite Statement (new) |
| Supply Chain Risk Management Program | Establish and operate a cybersecurity supply chain risk management program: strategy, objectives, policies and supplier-facing roles agreed by stakeholders; integration into enterprise risk management; verification of the authenticity and integrity of hardware and software before acquisition and use; supplier inclusion in incident planning, response and recovery; lifecycle-wide monitoring of supply chain security practices; and provisions for concluding supplier relationships. | Vendor & Third-Party Risk `frk_pt_685e462046667f75a50a2c3e` | Supply Chain Risk Register (new) |
| Incident & Recovery Communications | Maintain a stakeholder communication plan for incidents and recovery: who is notified, what is shared with designated internal and external stakeholders, how recovery progress is reported, and which approved methods and messaging are used for public updates. | Incident Response & Breach Notification `frk_pt_685e43e23b78127274355980` | Stakeholder Communication Plan (new) |
| Technology Asset Lifecycle | Manage systems, hardware, software, services and data through acquisition, maintenance, replacement and removal, including retirement of unsupported software and secure disposal of hardware and media at end of life. | Secure Configuration & Hardening `frk_pt_685e42a3bbd08ad14de297f0`; Retention & Secure Disposal `frk_pt_685e414029124c24387beff0` | Asset Disposal & Sanitization Log (new); Device List `frk_tt_68406903839203801ac8041a` |

New task templates (10), `automationStatus: MANUAL`, new `frk_tt_` ids.
The narrowly scoped existing tasks that revision 1 reused (an AI-management-system stakeholder register, an ePHI risk analysis, an ePHI media log) are not reused; general ones are added instead.
"Asset Disposal & Sanitization Log" overlaps the existing "Secure Storage" task, which asks for secure-destruction proof for physical media; the new task is broader (hardware, media and software retirement, replacement and removal, with accountable owner) and is kept as a distinct template.

| Name | Description | Frequency | Department |
|---|---|---|---|
| Interested Parties Register | Maintain a register of the organization's mission and how it informs cybersecurity risk decisions, and of internal and external interested parties (customers, regulators, employees, partners, suppliers), their cybersecurity needs and expectations, and how the organization addresses them. Review annually. | yearly | gov |
| Critical Services & Dependencies Statement | Maintain a statement of the critical objectives, capabilities and services that external parties depend on or expect from the organization, and of the outcomes, capabilities and services the organization itself depends on, with criticality ratings. Review annually. | yearly | gov |
| Risk Appetite Statement | Maintain an approved risk appetite and risk tolerance statement, including the accepted risk response options and how strategic opportunities (positive risks) are considered. Review annually and after major changes. | yearly | gov |
| Risk Register & Treatment Plan | Maintain the cybersecurity risk register: risk management objectives agreed by organizational stakeholders, identified threats and vulnerabilities, likelihood and impact, resulting prioritization, chosen responses, owners and tracking, and how risks are communicated across the organization and with suppliers. Review quarterly. | quarterly | gov |
| Security Metrics Report | Report the defined security metrics and KPIs to management on the agreed cadence, including how cybersecurity strategy outcomes and risk management performance were reviewed and any adjustments decided. | quarterly | gov |
| Supply Chain Risk Register | Maintain a register of suppliers ranked by criticality with their assessed cybersecurity risk, contract security requirements, results of authenticity and integrity checks for acquired hardware and software, incident-response involvement, and end-of-relationship provisions. | quarterly | gov |
| Stakeholder Communication Plan | Maintain the incident and recovery communication plan: notification lists, designated internal and external stakeholders, recovery progress reporting, and approved methods and messaging for public updates. | yearly | gov |
| Threat Intelligence Review | Record the cyber threat intelligence sources in use, the periodic review of received intelligence against the organization's assets and risks, and how intelligence is fed into monitoring and event analysis. | quarterly | it |
| Vulnerability Disclosure Handling | Maintain the channel for receiving vulnerability disclosures from researchers and third parties, and the log of disclosures received, analyzed, and responded to. | quarterly | it |
| Asset Disposal & Sanitization Log | Maintain a log of hardware, media and software retired, replaced or removed, including sanitization or destruction method, date and accountable owner. | quarterly | it |

CSF-scoped links added to existing controls (26 links on 18 controls).
These are rows in the scoped link tables with `frameworkId` = CSF; the global relations and every other framework's links are unchanged.

| Control (id) | Added policy | Added task(s) |
|---|---|---|
| Scope & Governance `frk_ct_69e6766bd8ca18f572d4c34f` | Information Security & Privacy Governance `frk_pt_685e3f7b4ebcb27b60c51434` | Interested Parties Register (new) |
| Performance Monitoring & Measurement `frk_ct_69e6766b4fd2b466bf7686cf` | Information Security & Privacy Governance `frk_pt_685e3f7b4ebcb27b60c51434` | Security Metrics Report (new); Management Review Minutes `frk_tt_68e1d619944625cc1876540c` |
| Continual Improvement & Corrective Action `frk_ct_69e6766bd483954a1f0b8445` | Internal Audit Procedure `frk_pt_691e4bd04aac53e783cb7c14` | Corrective Action Reports `frk_tt_691e6d9cb17ea23bfc68c57b` |
| Security Awareness & Training `frk_ct_69eb876f3270ed0b11233ece` | Security & Privacy Awareness Training `frk_pt_685e458a49e1eff0af54e3d2` | Training / Competence Records `frk_tt_691e56cc5a52ee1256d5e1d6` |
| Supplier & Third-Party Security `frk_ct_69e639b9bf66b5a6ffb17d27` | - | Supplier Evaluation Records `frk_tt_691e56cccca43b5df5080439` |
| Threat intelligence `frk_ct_684073d541bfb8b8b777e529` | - | Threat Intelligence Review (new) |
| Business Continuity & ICT Readiness `frk_ct_69e639b9d5ced482c12ae932` | - | Contingency Plan Testing & Revision `frk_tt_69eb8760d56cb8d18c53df13` |
| Physical & Environmental Security `frk_ct_69e65ef9c20933590d85cc31` | - | Facility Security Plan `frk_tt_69eb875fa49f13b4b81e9f3b` |
| Human Resources Security `frk_ct_69e639b958a20954c4afa186` | Background Screening & On/Off-boarding `frk_pt_685e45c938ad29ad775a2344` | - |
| Risk Management `frk_ct_69e639b90a3bf8c1443cbf5b` | - | Risk Register & Treatment Plan (new) |
| Risk Management `frk_ct_683f484fc7b5506ab97c26af` | - | Risk Register & Treatment Plan (new) |
| Management Security Accountability `frk_ct_683f41e775f4ca03d8f6bae2` | - | Management Review Minutes `frk_tt_68e1d619944625cc1876540c` |
| Asset Inventory `frk_ct_683f42c71eea99f22f9df060` | - | Infrastructure Inventory `frk_tt_69033a6bfeb4759be36257bc`; Diagramming `frk_tt_6849aad98c50d734dd904d98` |
| Access Rights `frk_ct_683f4a410cf5bf6d40bf3583` | - | Role-based Access Controls `frk_tt_68e80544d9734e0402cfa807` |
| Secure SDLC Integration `frk_ct_683f50aae46f5e4e096e6bb3` | - | Secure Code `frk_tt_68406e353df3bc002994acef`; Static Code Scanning `frk_tt_69f0d514d103c34ca40ad332` |
| Network Security `frk_ct_684070f0b4f6c2036306e23c` | - | Diagramming `frk_tt_6849aad98c50d734dd904d98` |
| Disaster Recovery Planning `frk_ct_683f4dd564057a97ae323c9f` | - | Backup Restoration Test `frk_tt_68e52b269db179c434734766`; Backup logs `frk_tt_68e52b26b166e2c0a0d11956` |
| Vulnerability Management `frk_ct_683f4d7360a876b972aba39a` | - | Vulnerability Disclosure Handling (new) |

Qualified reuse, stated so it is not read as full coverage: "Facility Security Plan" and "Training / Competence Records" are HIPAA and QMS templates whose wording is general enough for CSF but which mention their origin; the CCPA-specific "Annual Incident Response Tabletop Exercise" is not reused.

### 5.5 Reconciliation

Reconciliation is the seed step in 5.3: for CSF the crosswalk file is authoritative for requirement-to-control mappings and for scoped links, and the seed sets exactly that state.
Republishing after a crosswalk change is done through the framework editor's publish endpoint (`FrameworkVersionsService.publish`), which now uses the shared builder.
Organizations then move to the new version through the existing sync flow (`POST /v1/frameworks/:id/sync`).

### 5.6 Tests

`packages/db` tests use `bun:test` against the local database with the existing destructive-test guard (`backfill-framework-versions.spec.ts` is the pattern).
A `test` script (`bun test src`) is added to `packages/db/package.json` so `turbo test` includes the package.

Static tests (`apply-csf-crosswalk.spec.ts`, no database):

1. The crosswalk covers exactly the 106 official subcategory ids from `nist-csf-2.0-core.json`.
2. Every control, policy and task id resolves and the recorded name equals the template name exactly (no trimming).
3. Every control used has, after CSF-scoped links, at least one policy and one task.
4. Running the generator against the committed files is a no-op (CI fails on hand edits).
5. Non-CSF rows of the requirement relation file are byte-for-byte unchanged by the generator.
6. The 106 requirement rows equal NIST text, category name, Function name and order.
7. Every quoted span in every rationale is an exact substring of a text belonging to a mapped control (its description or name, a linked policy's name or text, a linked task's name or description, or a new template's definition).

Database tests (`csf-seed.spec.ts`, guarded like the existing spec):

8. After seeding, the CSF `1.0.0` manifest lists 106 requirements with `identifier`, `requirementFamily` and `sortOrder` in NIST order, each with at least one control, and every control with at least one policy id and one task id.
9. `buildManifestForFramework(CSF)` deep-equals the stored backfilled manifest (one builder, so this is a regression guard, not an id-set comparison).
10. Reconciliation: with a copy of the crosswalk that removes one control from one requirement, run the seed twice; after each run the removed requirement-control row and its CSF scoped rows are absent, and every other framework's requirement-control and scoped-link counts are unchanged.
11. Scoped-link population is idempotent: running the seed twice yields identical scoped-link row sets for every framework.
12. Instance isolation: for an organization with SOC 2 and CSF instances, after adding CSF and re-running the seed, the SOC 2 instance's `FrameworkControlTaskLink` and `FrameworkControlPolicyLink` sets equal those derived from its pinned manifest, and contain none of the CSF-only task ids.

### 5.7 Rollout on this machine

Preconditions to verify at rollout time (they held at the snapshot in section 3): the CSF `1.0.0` version is referenced by no `FrameworkInstance.currentVersionId`, no `FrameworkSyncOperation.fromVersionId` and no `FrameworkSyncOperation.toVersionId`; all three scoped editor link tables are empty.

1. Delete that `FrameworkVersion` row.
2. `cd packages/db && bun run db:seed`. Effects on this database: the 106 CSF requirement rows are updated in place; new templates and relations are inserted; scoped editor links are populated for every framework (the three tables go from empty to populated); for CSF the crosswalk state is set exactly; `backfillFrameworkVersions` creates CSF `1.0.0` with the shared builder and leaves every existing version row untouched (SOC 2's stored `1.0.0` manifest is therefore byte-for-byte unchanged; a manifest freshly published for SOC 2 later would additionally carry `requirementFamily`, `sortOrder`, `controlFamily` and `documentTypes`, with the same policy and task id sets); the SOC 2 instance already has `currentVersionId` set and its instance-level links are recomputed from its pinned manifest, which yields the same 63, 76 and 9 rows.
3. In the app: Overview, Add Framework, NIST CSF 2.0.

Fresh installs need no special step.

### 5.8 Acceptance

- `FrameworkEditorFramework` CSF row: `visible = true`.
- CSF `1.0.0` manifest: 106 requirements, each with `identifier`, `requirementFamily`, `sortOrder` and at least one control; every control with at least one policy and one task.
- `buildManifestForFramework(CSF)` deep-equals the stored manifest (test 9).
- The organization has a CSF `FrameworkInstance`; its requirement pages show 106 requirements grouped by Function in NIST order.
- Organization control, policy and task counts increase by exactly the number of templates the organization did not already have; no duplicate by template id.
- SOC 2: 63 requirements, 35 controls, 25 policies, 26 tasks unchanged; its instance-level link counts (63, 76, 9) unchanged after adding CSF and after a further seed run.
- A control shared by both frameworks (for example Access Rights) shows the same evidence status under both.
- `bun test src` in `packages/db` passes; `bun run check-types` in `packages/db` and `bun run typecheck` at the root pass.

## 6. Mapping principles and resulting numbers

1. One to three controls per subcategory: 43 subcategories map to one control, 60 to two, 3 to three; 172 links; 48 distinct controls (43 existing, 5 new).
2. Choose the control whose evidence demonstrates the outcome, and add a CSF-scoped evidence task where an existing control's tasks do not (26 scoped links on 18 controls).
3. Prefer existing controls with explicit descriptions over new ones. Three existing controls that revision 1 overlooked are used: Scope & Governance, Performance Monitoring & Measurement, Data Inventory and Mapping. Two of revision 1's new controls were dropped as a result.
4. Add a control only where nothing in the library produces the required artifact: appetite statement, dependency statement, supply chain program, communications plan, lifecycle process.
5. 28 rows are marked "Judgment mapping." because no mapped control's description states the outcome; the rationale says what does (a policy clause or a task) or that it is procedure content not yet evidenced.

## 7. Crosswalk

Each row: NIST's subcategory text (verbatim from the export), NIST's SP 800-53 Rev 5 informative references (union of the export's 5.1.1 and 5.2.0 entries), the Comp controls (id suffix for existing controls), and the rationale.
Quoted spans are verbatim substrings of the seed (control description, policy clause, task description or template name) or of a new template's description in section 5.4.

<!-- BEGIN GENERATED CROSSWALK -->

#### GV.OC Organizational Context

> The circumstances - mission, stakeholder expectations, dependencies, and legal, regulatory, and contractual requirements - surrounding the organization's cybersecurity risk management decisions are understood

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **GV.OC-01** The organizational mission is understood and informs cybersecurity risk management | PM-11 | Scope & Governance `72d4c34f` | Parent: Scope & Governance, whose description covers "internal and external context"; the mission is part of that context. Evidence: Interested Parties Register (CSF-scoped, new), which records "the organization's mission and how it informs cybersecurity risk decisions". Judgment mapping. |
| **GV.OC-02** Internal and external stakeholders are understood, and their needs and expectations regarding cybersecurity risk management are understood and considered | PM-09, PM-18, PM-30, SR-03, SR-05, SR-06, SR-08 | Scope & Governance `72d4c34f` | Parent: Scope & Governance, whose description names "interested parties". Evidence: Interested Parties Register (new) records their needs and expectations. |
| **GV.OC-03** Legal, regulatory, and contractual requirements regarding cybersecurity - including privacy and civil liberties obligations - are understood and managed | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PM-28, PS-01, PT, PT-01, RA-01, SA-01, SC-01, SI-01, SR-01 | Legal, Regulatory & IP Compliance `7c8936fc` | Parent: Legal, Regulatory & IP Compliance, which "Maintains an obligations register for applicable laws, regulations, contracts, and IP". Policy: Compliance & Regulatory Monitoring. |
| **GV.OC-04** Critical objectives, capabilities, and services that external stakeholders depend on or expect from the organization are understood and communicated | CP-02(08), PM-08, PM-11, PM-30(01), RA-09 | Critical Services & Dependencies (new); Business Continuity & ICT Readiness `c12ae932` | Parent: the new Critical Services & Dependencies control (services external parties depend on, with criticality). Business Continuity & ICT Readiness "Extends DR to include BIA", which quantifies that criticality. Evidence: Critical Services & Dependencies Statement (new), Contingency Plan Testing & Revision. |
| **GV.OC-05** Outcomes, capabilities, and services that the organization depends on are understood and communicated | PM-11, PM-30, RA-07, SA-09, SR-05 | Critical Services & Dependencies (new); Supplier & Third-Party Security `ffb17d27` | Parent: the new Critical Services & Dependencies control (what the organization depends on). External dependencies are suppliers under Supplier & Third-Party Security ("supply-chain risk for ICT services"). Evidence: Critical Services & Dependencies Statement (new), Supplier Evaluation Records. |

#### GV.RM Risk Management Strategy

> The organization's priorities, constraints, risk tolerance and appetite statements, and assumptions are established, communicated, and used to support operational risk decisions

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **GV.RM-01** Risk management objectives are established and agreed to by organizational stakeholders | PM-09, RA-07, SR-02 | Risk Management `b97c26af` | Parent: Risk Management ("Maintain a Risk Management Program"). The control description does not state objectives; the CSF-scoped task Risk Register & Treatment Plan (new) records "risk management objectives agreed by organizational stakeholders". Policy: Risk Management. Judgment mapping. |
| **GV.RM-02** Risk appetite and risk tolerance statements are established, communicated, and maintained | PM-09 | Risk Appetite & Tolerance (new) | No existing control or task produces appetite and tolerance statements. Parent: new Risk Appetite & Tolerance control. Evidence: Risk Appetite Statement (new). |
| **GV.RM-03** Cybersecurity risk management activities and outcomes are included in enterprise risk management processes | PM-03, PM-09, PM-30, RA-07, SA-24, SR-02 | Risk Management `b97c26af` | Parent: Risk Management. No control description or task states integration into enterprise risk management; the program is the place it would be implemented. Judgment mapping. |
| **GV.RM-04** Strategic direction that describes appropriate risk response options is established and communicated | PM-09, PM-28, PM-30, SR-02 | Risk Appetite & Tolerance (new); Risk Management `b97c26af` | Parent: new Risk Appetite & Tolerance control, whose description includes "the strategic direction on acceptable risk response options"; responses are executed under Risk Management. Evidence: Risk Appetite Statement (new). |
| **GV.RM-05** Lines of communication across the organization are established for cybersecurity risks, including risks from suppliers and other third parties | PM-09, PM-30 | Risk Management `b97c26af`; Supplier & Third-Party Security `ffb17d27` | Parent: Risk Management for internal communication lines, evidenced by the Risk Register & Treatment Plan task ("and with suppliers"); Supplier & Third-Party Security for the supplier side. |
| **GV.RM-06** A standardized method for calculating, documenting, categorizing, and prioritizing cybersecurity risks is established and communicated | PM-09, PM-18, PM-28, PM-30, RA-03 | Risk Management `443cbf5b` | Parent: the ISO-variant Risk Management control, described as a "Formal risk identification, assessment, treatment, and monitoring process, including risk register and treatment plans", which is the standardized method the subcategory requires. Evidence: Risk Register & Treatment Plan (new). |
| **GV.RM-07** Strategic opportunities (i.e., positive risks) are characterized and are included in organizational cybersecurity risk discussions | PM-09, PM-18, PM-28, PM-30, RA-03 | Risk Appetite & Tolerance (new) | Parent: new Risk Appetite & Tolerance control, whose description includes "the treatment of strategic opportunities (positive risks)". No existing control covers opportunities. |

#### GV.RR Roles, Responsibilities, and Authorities

> Cybersecurity roles, responsibilities, and authorities to foster accountability, performance assessment, and continuous improvement are established and communicated

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **GV.RR-01** Organizational leadership is responsible and accountable for cybersecurity risk and fosters a culture that is risk-aware, ethical, and continually improving | PM-02, PM-19, PM-23, PM-24, PM-29 | Management Security Accountability `d8f6bae2`; Organization Structure & Reporting Lines `53e31fa0` | Parent: Management Security Accountability ("Ensure Management Addresses Security Responsibilities") and Organization Structure & Reporting Lines ("Management establishes, with board oversight, structures, reporting lines, authorities, and responsibilities"). Evidence: Management Review Minutes (CSF-scoped). |
| **GV.RR-02** Roles, responsibilities, and authorities related to cybersecurity risk management are established, communicated, understood, and enforced | PM-02, PM-13, PM-19, PM-23, PM-24, PM-29 | Security Governance Roles `88e2989a`; Organization Structure & Reporting Lines `53e31fa0` | Parent: Security Governance Roles ("Define Security Roles and Responsibilities") and Organization Structure & Reporting Lines for authorities and reporting lines. |
| **GV.RR-03** Adequate resources are allocated commensurate with the cybersecurity risk strategy, roles, responsibilities, and policies | PM-03 | Management Security Accountability `d8f6bae2`; Scope & Governance `72d4c34f` | Parent: Management Security Accountability; Scope & Governance "Establishes top-management commitment". No description or task evidences resource allocation. Judgment mapping. |
| **GV.RR-04** Cybersecurity is included in human resources practices | PM-13, PS-01, PS-07, PS-09 | Personnel Security `4e63220f`; Human Resources Security `c4afa186` | Parent: Personnel Security ("Screen onboard offboard securely") and Human Resources Security ("Owns pre-employment screening, confidentiality agreements, awareness training curriculum, and disciplinary handling for security violations"). |

#### GV.PO Policy

> Organizational cybersecurity policy is established, communicated, and enforced

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **GV.PO-01** Policy for managing cybersecurity risks is established based on organizational context, cybersecurity strategy, and priorities and is communicated and enforced | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PS-01, PT-01, RA-01, SA-01, SC-01, SI-01, SR-01 | Policy Compliance `624c59c1` | Parent: Policy Compliance ("Ensure Compliance with Security Policies and Standards"), whose linked policies include "Information Security & Privacy Governance" and "Policy Management & Exception Handling". |
| **GV.PO-02** Policy for managing cybersecurity risks is reviewed, updated, communicated, and enforced to reflect changes in requirements, threats, technology, and organizational mission | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PS-01, PT-01, RA-01, SA-01, SC-01, SI-01, SR-01 | Policy Compliance `624c59c1` | Parent: Policy Compliance; review and update cadence is governed by its "Policy Management & Exception Handling" policy. |

#### GV.OV Oversight

> Results of organization-wide cybersecurity risk management activities and performance are used to inform, improve, and adjust the risk management strategy

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **GV.OV-01** Cybersecurity risk management strategy outcomes are reviewed to inform and adjust strategy and direction | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PM-09, PM-18, PM-30, PM-31, PS-01, PT-01, RA-01, RA-07, SA-01, SC-01, SI-01, SR-01, SR-06 | Performance Monitoring & Measurement `bf7686cf`; Internal Audit & Management Review `29676acb` | Parent: Performance Monitoring & Measurement ("Measures how well the ISMS is achieving its intended outcomes by defining security metrics and KPIs") and Internal Audit & Management Review ("facilitates periodic management review of ISMS effectiveness"). Evidence: Security Metrics Report (new), Management Review Minutes. |
| **GV.OV-02** The cybersecurity risk management strategy is reviewed and adjusted to ensure coverage of organizational requirements and risks | PM-09, PM-19, PM-30, PM-31, RA-07, SR-06 | Internal Audit & Management Review `29676acb`; Performance Monitoring & Measurement `bf7686cf` | Parent: Internal Audit & Management Review, where strategy adjustments are decided; Performance Monitoring & Measurement supplies the inputs. Evidence: Management Review Minutes, Security Metrics Report (new). |
| **GV.OV-03** Organizational cybersecurity risk management performance is evaluated and reviewed for adjustments needed | PM-04, PM-06, RA-07, SR-06 | Performance Monitoring & Measurement `bf7686cf`; Internal Audit & Management Review `29676acb` | Parent: Performance Monitoring & Measurement, which collects "results on a defined cadence, and reporting them to management"; Internal Audit & Management Review evaluates them. Evidence: Security Metrics Report (new), Internal Security Audit. |

#### GV.SC Cybersecurity Supply Chain Risk Management

> Cyber supply chain risk management processes are identified, established, managed, monitored, and improved by organizational stakeholders

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **GV.SC-01** A cybersecurity supply chain risk management program, strategy, objectives, policies, and processes are established and agreed to by organizational stakeholders | PM-30, SR-02, SR-03 | Supply Chain Risk Management Program (new) | No existing control establishes a C-SCRM program with "strategy, objectives, policies" as a unit; the new control does. Policy: Vendor & Third-Party Risk. Evidence: Supply Chain Risk Register (new). |
| **GV.SC-02** Cybersecurity roles and responsibilities for suppliers, customers, and partners are established, communicated, and coordinated internally and externally | SR-02, SR-03, SR-05 | Supply Chain Risk Management Program (new); Security Governance Roles `88e2989a` | Parent: new program control, whose description includes "supplier-facing roles"; internal role definition is Security Governance Roles. |
| **GV.SC-03** Cybersecurity supply chain risk management is integrated into cybersecurity and enterprise risk management, risk assessment, and improvement processes | AC-01, AT-01, AU-01, CA-01, CM-01, CP-01, IA-01, IR-01, MA-01, MP-01, PE-01, PL-01, PM-01, PM-09, PM-18, PM-30, PM-31, PS-01, PT-01, RA-01, RA-03, RA-07, SA-01, SC-01, SI-01, SR-01, SR-02, SR-03 | Supply Chain Risk Management Program (new); Risk Management `b97c26af` | Parent: new program control ("integration into enterprise risk management") and Risk Management. |
| **GV.SC-04** Suppliers are known and prioritized by criticality | RA-09, SA-09, SR-06 | Supply Chain Risk Management Program (new); Supplier & Third-Party Security `ffb17d27` | Parent: Supplier & Third-Party Security for the supplier register; the new program control for criticality ranking. Evidence: Supply Chain Risk Register (new), described as "suppliers ranked by criticality". |
| **GV.SC-05** Requirements to address cybersecurity risks in supply chains are established, prioritized, and integrated into contracts and other types of agreements with suppliers and other relevant third parties | SA-04, SA-09, SR-03, SR-05, SR-06, SR-10 | Supplier & Third-Party Security `ffb17d27` | Parent: Supplier & Third-Party Security, which "Manages supplier due diligence, contract clauses, ongoing monitoring". Evidence: Supplier Evaluation Records. |
| **GV.SC-06** Planning and due diligence are performed to reduce risks before entering into formal supplier or other third-party relationships | SA-04, SA-09, SR-05, SR-06 | Supplier & Third-Party Security `ffb17d27` | Parent: Supplier & Third-Party Security ("supplier due diligence"). Evidence: Supplier Evaluation Records ("evaluated, selected, and monitored against defined criteria"). |
| **GV.SC-07** The risks posed by a supplier, their products and services, and other third parties are understood, recorded, prioritized, assessed, responded to, and monitored over the course of the relationship | RA-09, SA-04, SA-09, SR-03, SR-06 | Supplier & Third-Party Security `ffb17d27`; Risk Management `b97c26af` | Parent: Supplier & Third-Party Security ("ongoing monitoring"); supplier risks are tracked in the risk register under Risk Management. |
| **GV.SC-08** Relevant suppliers and other third parties are included in incident planning, response, and recovery activities | CP-01, IR-01, SA-04, SA-09, SR-02, SR-03, SR-08 | Supply Chain Risk Management Program (new); Security Incident Management `03d6bee8` | Parent: new program control ("supplier inclusion in incident planning, response and recovery") executed through Security Incident Management. |
| **GV.SC-09** Supply chain security practices are integrated into cybersecurity and enterprise risk management programs, and their performance is monitored throughout the technology product and service life cycle | PM-09, PM-19, PM-28, PM-30, PM-31, RA-03, RA-07, SA-04, SA-09, SR-02, SR-03, SR-05, SR-06 | Supply Chain Risk Management Program (new) | Parent: new program control ("lifecycle-wide monitoring of supply chain security practices"). |
| **GV.SC-10** Cybersecurity supply chain risk management plans include provisions for activities that occur after the conclusion of a partnership or service agreement | PM-31, RA-03, RA-05, RA-07, SA-04, SA-09, SR-02, SR-03, SR-05, SR-06 | Supply Chain Risk Management Program (new); Data Retention & Destruction `528353c1` | Parent: new program control ("provisions for concluding supplier relationships"); data disposition at termination is Data Retention & Destruction ("Follow retention; securely dispose"). |

#### ID.AM Asset Management

> Assets (e.g., data, hardware, software, systems, facilities, services, people) that enable the organization to achieve business purposes are identified and managed consistent with their relative importance to organizational objectives and the organization's risk strategy

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **ID.AM-01** Inventories of hardware managed by the organization are maintained | CM-08, PM-05 | Asset Inventory `2f9df060` | Parent: Asset Inventory ("Maintain an Inventory of Information Assets"). Evidence: Device List ("laptops/servers"). |
| **ID.AM-02** Inventories of software, services, and systems managed by the organization are maintained | AC-20, CM-08, PM-05, SA-05, SA-09 | Asset Inventory `2f9df060` | Parent: Asset Inventory. Evidence: Infrastructure Inventory (CSF-scoped), which covers "cloud accounts, compute resources, databases, storage, and networks". Software and services beyond infrastructure are not required by any task. Judgment mapping. |
| **ID.AM-03** Representations of the organization's authorized network communication and internal and external network data flows are maintained | AC-04, CA-03, CA-09, PL-02, PL-08, PM-07 | Network Security `6306e23c`; Asset Inventory `2f9df060` | Parent: Network Security and Asset Inventory. Neither description mentions flow representations; the CSF-scoped Diagramming task ("Data Flow Diagram") supplies them. Judgment mapping. |
| **ID.AM-04** Inventories of services provided by suppliers are maintained | AC-20, SA-09, SR-02 | Supplier & Third-Party Security `ffb17d27`; Asset Inventory `2f9df060` | Parent: Supplier & Third-Party Security for the supplier register; Asset Inventory records the services consumed. Evidence: Supplier Evaluation Records, Infrastructure Inventory. |
| **ID.AM-05** Assets are prioritized based on classification, criticality, resources, and impact on the mission | RA-02, RA-03, RA-09 | Information Classification `de7b9c31`; Asset Inventory `2f9df060` | Parent: Information Classification ("Classify Information by Sensitivity") for the classification input; Asset Inventory for the prioritized list. Criticality and impact fields are not required by either description. Judgment mapping. |
| **ID.AM-07** Inventories of data and corresponding metadata for designated data types are maintained | CM-12, CM-13, SI-12 | Data Inventory and Mapping `f933a112`; Information Classification `de7b9c31` | Parent: Data Inventory and Mapping ("Maintain a documented inventory of personal data processed by the organization, including data categories, sources, purposes") for personal data; Information Classification ("Classify Information by Sensitivity") for other data. Inventories of non-personal designated data are not required by either. Judgment mapping. |
| **ID.AM-08** Systems, hardware, software, services, and data are managed throughout their life cycles | CM-09, CM-13, MA-02, MA-06, PL-02, PM-22, PM-23, SA-03, SA-04, SA-08, SA-22, SI-12, SI-18, SR-05, SR-12 | Technology Asset Lifecycle (new); Change management `7fa58e13` | Parent: new Technology Asset Lifecycle control ("acquisition, maintenance, replacement and removal"); lifecycle changes go through Change management ("Apply Change Management for Information Systems"). |

#### ID.RA Risk Assessment

> The cybersecurity risk to the organization, assets, and individuals is understood by the organization

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **ID.RA-01** Vulnerabilities in assets are identified, validated, and recorded | CA-02, CA-07, CA-08, RA-03, RA-05, SA-11(02), SA-15(07), SA-15(08), SI-04, SI-05 | Vulnerability Management `72aba39a` | Parent: Vulnerability Management ("Manage both software and code vulnerabilities"). Policy: Vulnerability & Patch Management. |
| **ID.RA-02** Cyber threat intelligence is received from information sharing forums and sources | PM-15, PM-16, SI-05 | Threat intelligence `b777e529` | Parent: Threat intelligence ("Implement a Threat Intelligence Program"). Evidence: Threat Intelligence Review (CSF-scoped, new). |
| **ID.RA-03** Internal and external threats to the organization are identified and recorded | PM-12, PM-16, RA-03, SI-05 | Risk Management `443cbf5b`; Threat intelligence `b777e529` | Parent: ISO-variant Risk Management ("Formal risk identification") for recording threats; Threat intelligence for external threats. Evidence: Risk Register & Treatment Plan (new), covering "identified threats and vulnerabilities". |
| **ID.RA-04** Potential impacts and likelihoods of threats exploiting vulnerabilities are identified and recorded | PM-09, PM-11, RA-02, RA-03, RA-08, RA-09 | Risk Management `443cbf5b` | Parent: ISO-variant Risk Management. Evidence: Risk Register & Treatment Plan (new), covering "likelihood and impact". |
| **ID.RA-05** Threats, vulnerabilities, likelihoods, and impacts are used to understand inherent risk and inform risk response prioritization | PM-16, RA-02, RA-03, RA-07 | Risk Management `443cbf5b`; Risk Management `b97c26af` | Parent: both Risk Management controls. Evidence: Risk Register & Treatment Plan (new), covering "resulting prioritization". |
| **ID.RA-06** Risk responses are chosen, prioritized, planned, tracked, and communicated | PM-09, PM-18, PM-30, RA-07 | Risk Management `443cbf5b` | Parent: ISO-variant Risk Management ("treatment plans"). Evidence: Risk Register & Treatment Plan (new), covering "chosen responses, owners and tracking". |
| **ID.RA-07** Changes and exceptions are managed, assessed for risk impact, recorded, and tracked | CA-07, CM-03, CM-04 | Change management `7fa58e13`; Policy Compliance `624c59c1` | Parent: Change management for changes; Policy Compliance for exceptions via its "Policy Management & Exception Handling" policy. |
| **ID.RA-08** Processes for receiving, analyzing, and responding to vulnerability disclosures are established | RA-05 | Vulnerability Management `72aba39a`; Security Incident Management `03d6bee8` | Parent: Vulnerability Management. Disclosure intake is not in the control description; the CSF-scoped Vulnerability Disclosure Handling task (new) adds it. Response follows Security Incident Management. Judgment mapping. |
| **ID.RA-09** The authenticity and integrity of hardware and software are assessed prior to acquisition and use | SA-04, SA-05, SA-10, SA-11, SA-15, SA-17, SI-07, SR-05, SR-06, SR-10, SR-11 | Supply Chain Risk Management Program (new); Secure SDLC Integration `096e6bb3` | Parent: new program control, whose description includes "verification of the authenticity and integrity of hardware and software before acquisition and use"; software integrity in delivery is Secure SDLC Integration. Evidence: Supply Chain Risk Register (new), covering "results of authenticity and integrity checks". |
| **ID.RA-10** Critical suppliers are assessed prior to acquisition | SR-06 | Supplier & Third-Party Security `ffb17d27` | Parent: Supplier & Third-Party Security ("supplier due diligence"). Evidence: Supplier Evaluation Records. |

#### ID.IM Improvement

> Improvements to organizational cybersecurity risk management processes, procedures and activities are identified across all CSF Functions

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **ID.IM-01** Improvements are identified from evaluations | AC-01, AT-01, AU-01, CA-01, CA-02, CA-05, CA-07, CA-08, CM-01, CP-01, CP-02, IA-01, IR-01, IR-04, IR-08, MA-01, MP-01, PE-01, PL-01, PL-02, PM-01, PS-01, PT-01, RA-01, RA-03, RA-05, RA-07, SA-01, SA-08, SA-11, SA-17(06), SC-01, SI-01, SI-02, SI-04, SR-01, SR-05 | Continual Improvement & Corrective Action `1f0b8445`; Internal Audit & Management Review `29676acb` | Parent: Continual Improvement & Corrective Action, which "Captures nonconformities identified through audits, incidents, management reviews, or day-to-day operations"; audits come from Internal Audit & Management Review. Evidence: Corrective Action Reports (CSF-scoped). |
| **ID.IM-02** Improvements are identified from security tests and exercises, including those done in coordination with suppliers and relevant third parties | AC-01, AT-01, AU-01, CA-01, CA-02, CA-05, CA-07, CA-08, CM-01, CP-01, CP-02, CP-04, IA-01, IR-01, IR-03, IR-04, IR-08, MA-01, MP-01, PE-01, PL-01, PL-02, PM-01, PM-04, PM-31, PS-01, PT-01, RA-01, RA-03, RA-05, RA-07, SA-01, SA-08, SA-11, SC-01, SI-01, SI-02, SI-04, SR-01, SR-05 | Continual Improvement & Corrective Action `1f0b8445`; Disaster Recovery Planning `ae323c9f` | Parent: Continual Improvement & Corrective Action; test findings come from Disaster Recovery Planning ("Test DR; meet RTO/RPO"). Evidence: Corrective Action Reports, Backup Restoration Test. |
| **ID.IM-03** Improvements are identified from execution of operational processes, procedures, and activities | AC-01, AT-01, AU-01, CA-01, CA-02, CA-05, CA-07, CA-08, CM-01, CP-01, CP-02, IA-01, IR-01, IR-04, IR-08, MA-01, MP-01, PE-01, PL-01, PL-02, PM-01, PM-04, PM-31, PS-01, PT-01, RA-01, RA-03, RA-05, RA-07, SA-01, SA-04, SA-08, SA-11, SC-01, SI-01, SI-02, SI-04, SR-01, SR-05 | Continual Improvement & Corrective Action `1f0b8445` | Parent: Continual Improvement & Corrective Action ("or day-to-day operations"). |
| **ID.IM-04** Incident response plans and other cybersecurity plans that affect operations are established, communicated, maintained, and improved | CP-02, IR-08, PL-02, SR-02 | Security Incident Management `03d6bee8`; Disaster Recovery Planning `ae323c9f`; Continual Improvement & Corrective Action `1f0b8445` | Parent: Security Incident Management and Disaster Recovery Planning own the plans; Continual Improvement & Corrective Action "Feeds lessons learned back into policies, controls, and the risk register". |

#### PR.AA Identity Management, Authentication, and Access Control

> Access to physical and logical assets is limited to authorized users, services, and hardware and  managed commensurate with the assessed risk of unauthorized access

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **PR.AA-01** Identities and credentials for authorized users, services, and hardware are managed by the organization | AC-01, AC-02, AC-14, IA-01, IA-02, IA-03, IA-04, IA-05, IA-06, IA-07, IA-08, IA-09, IA-10, IA-11 | Access Rights `40bf3583`; Credential Management `e558a6f5` | Parent: Access Rights ("Manage User Access Rights Lifecycle") and Credential Management ("Protect Authentication Information"). Evidence: Employee Access, Access Review Log, 2FA, Secure Secrets. |
| **PR.AA-02** Identities are proofed and bound to credentials based on the context of interactions | IA-12 | Access Rights `40bf3583`; Personnel Security `4e63220f` | Parent: Access Rights for binding identities to credentials; Personnel Security for proofing at onboarding. Evidence: Employee Verification. |
| **PR.AA-03** Users, services, and hardware are authenticated | AC-07, AC-12, IA-02, IA-03, IA-05, IA-07, IA-08, IA-09, IA-10, IA-11 | Credential Management `e558a6f5` | Parent: Credential Management. Evidence: 2FA, Secure Secrets. |
| **PR.AA-04** Identity assertions are protected, conveyed, and verified | IA-13 | Credential Management `e558a6f5` | Parent: Credential Management ("Protect Authentication Information"). The description does not address assertion conveyance specifically. Judgment mapping. |
| **PR.AA-05** Access permissions, entitlements, and authorizations are defined in a policy, managed, enforced, and reviewed, and incorporate the principles of least privilege and separation of duties | AC-01, AC-02, AC-03, AC-05, AC-06, AC-10, AC-16, AC-17, AC-18, AC-19, AC-24, IA-13 | Access Rights `40bf3583`; Segregation of duties `ba048022` | Parent: Access Rights and Segregation of duties ("Implement Segregation of Duties"). Evidence: Access Review Log and Role-based Access Controls (CSF-scoped), which requires "role-based access control (RBAC) to manage user permissions based on job functions". |
| **PR.AA-06** Physical access to assets is managed, monitored, and enforced commensurate with risk | PE-02, PE-03, PE-04, PE-05, PE-06, PE-08, PE-18, PE-19, PE-20 | Physical Access Control `676d93db` | Parent: Physical Access Control ("Control Physical Entry to Facilities"). Evidence: Visitor Control, Office Access & Door Monitoring. |

#### PR.AT Awareness and Training

> The organization's personnel are provided with cybersecurity awareness and training so that they can perform their cybersecurity-related tasks

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **PR.AT-01** Personnel are provided with awareness and training so that they possess the knowledge and skills to perform general tasks with cybersecurity risks in mind | AT-02, AT-03 | Security Awareness & Training `11233ece`; Personnel Security `4e63220f` | Parent: Security Awareness & Training ("Implement a security awareness and training program"); Personnel Security carries the Security & Privacy Awareness Training policy. Evidence: Security Awareness Training. |
| **PR.AT-02** Individuals in specialized roles are provided with awareness and training so that they possess the knowledge and skills to perform relevant tasks with cybersecurity risks in mind | AT-03 | Security Awareness & Training `11233ece` | Parent: Security Awareness & Training. Role-specific evidence: Training / Competence Records (CSF-scoped), which "must cover role-specific skills". Judgment mapping. |

#### PR.DS Data Security

> Data are managed consistent with the organization's risk strategy to protect the confidentiality, integrity, and availability of information

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **PR.DS-01** The confidentiality, integrity, and availability of data-at-rest are protected | CA-03, CP-09, MP-08, SC-04, SC-07, SC-12, SC-13, SC-28, SC-32, SC-39, SC-43, SI-03, SI-04, SI-07 | Encrypted Data at Rest `63fc79d9`; Information Classification `de7b9c31` | Parent: Encrypted Data at Rest ("The organization encrypts all production databases containing customer data at rest"); Information Classification determines which data needs which protection. |
| **PR.DS-02** The confidentiality, integrity, and availability of data-in-transit are protected | AU-16, CA-03, SC-04, SC-07, SC-08, SC-11, SC-12, SC-13, SC-16, SC-40, SC-43, SI-03, SI-04, SI-07 | Secure Data Transfer `cc085ded` | Parent: Secure Data Transfer ("Protect Information in Transit"). Evidence: TLS / HTTPS. |
| **PR.DS-10** The confidentiality, integrity, and availability of data-in-use are protected | AC-02, AC-03, AC-04, AU-09, AU-13, CA-03, CP-09, SA-08, SC-04, SC-07, SC-11, SC-13, SC-24, SC-32, SC-39, SC-40, SC-43, SI-03, SI-04, SI-07, SI-10, SI-16 | Data Masking `1446ce78`; Access Rights `40bf3583` | Parent: Data Masking ("Hide sensitive fields") for data in use; Access Rights limits who can process it. The library has no dedicated data-in-use control. Judgment mapping. |
| **PR.DS-11** Backups of data are created, protected, maintained, and tested | CP-06, CP-09 | Disaster Recovery Planning `ae323c9f` | Parent: Disaster Recovery Planning (policy: Backup, Business Continuity & Disaster Recovery). Evidence: Backup Restoration Test and Backup logs (both CSF-scoped). |

#### PR.PS Platform Security

> The hardware, software (e.g., firmware, operating systems, applications), and services of physical and virtual platforms are managed consistent with the organization's risk strategy to protect their confidentiality, integrity, and availability

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **PR.PS-01** Configuration management practices are established and applied | CM-01, CM-02, CM-03, CM-04, CM-05, CM-06, CM-07, CM-08, CM-09, CM-10, CM-11 | Configuration & Patch Management `c0f3a3ae`; Change management `7fa58e13` | Parent: Configuration & Patch Management ("Harden baselines") and Change management for baseline changes. |
| **PR.PS-02** Software is maintained, replaced, and removed commensurate with risk | CM-11, MA-03(06), SA-10(01), SI-02, SI-07 | Configuration & Patch Management `c0f3a3ae`; Vulnerability Management `72aba39a`; Technology Asset Lifecycle (new) | Parent: Configuration & Patch Management ("patch swiftly") and Vulnerability Management for maintenance; the new Technology Asset Lifecycle control ("retirement of unsupported software") for replacement and removal. |
| **PR.PS-03** Hardware is maintained, replaced, and removed commensurate with risk | CM-07(09), SA-10(03), SC-03(01), SC-39(01), SC-49, SC-51 | Technology Asset Lifecycle (new) | Parent: new Technology Asset Lifecycle control. Evidence: Asset Disposal & Sanitization Log (new), Device List. |
| **PR.PS-04** Log records are generated and made available for continuous monitoring | AU-02, AU-03, AU-06, AU-07, AU-11, AU-12, SA-15(13) | Security Logging `b4c2c4d8` | Parent: Security Logging ("Enable Logging of Security Events"). Policy: Logging, Monitoring & Audit. |
| **PR.PS-05** Installation and execution of unauthorized software are prevented | CM-07(02), CM-07(04), CM-07(05), SC-34 | Endpoint Protection `669076cc`; Configuration & Patch Management `c0f3a3ae` | Parent: Endpoint Protection ("Protect Systems Against Malware") and Configuration & Patch Management ("Harden baselines"), whose Secure Configuration & Hardening policy governs what may be installed. No control names application allow-listing explicitly. Judgment mapping. |
| **PR.PS-06** Secure software development practices are integrated, and their performance is monitored throughout the software development life cycle | SA-03, SA-08, SA-10, SA-11, SA-15, SA-15(13), SA-17, SA-24 | Secure SDLC Integration `096e6bb3`; Vulnerability Management `72aba39a` | Parent: Secure SDLC Integration (policy: Secure Software Development Lifecycle); "code vulnerabilities" are Vulnerability Management. Evidence: Secure Code and Static Code Scanning (both CSF-scoped). |

#### PR.IR Technology Infrastructure Resilience

> Security architectures are managed with the organization's risk strategy to protect asset confidentiality, integrity, and availability, and organizational resilience

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **PR.IR-01** Networks and environments are protected from unauthorized logical access and usage | AC-03, AC-04, SC-04, SC-05, SC-07 | Network Security `6306e23c`; Remote-Work Security `2b35ca8f` | Parent: Network Security ("Enforce segmentation and firewalls") and Remote-Work Security ("Implement Secure Remote Working Practices"). Evidence: Production Firewall & No-Public-Access Controls. |
| **PR.IR-02** The organization's technology assets are protected from environmental threats | CP-02, PE-09, PE-10, PE-11, PE-12, PE-13, PE-14, PE-15, PE-18, PE-23 | Physical & Environmental Security `0d85cc31` | Parent: Physical & Environmental Security ("environmental threat protections, cabling security, and secure siting of equipment"). Evidence: Facility Security Plan (CSF-scoped). |
| **PR.IR-03** Mechanisms are implemented to achieve resilience requirements in normal and adverse situations | CP, IR, SA-08, SA-24, SC-06, SC-24, SC-36, SC-39, SI-13 | Business Continuity & ICT Readiness `c12ae932`; Disaster Recovery Planning `ae323c9f` | Parent: Business Continuity & ICT Readiness ("continuity strategy, tabletop/real exercises, and ICT readiness commitments per service tier") and Disaster Recovery Planning. |
| **PR.IR-04** Adequate resource capacity to ensure availability is maintained | CP-06, CP-07, CP-08, PM-03, PM-09 | Resource Capacity Management `b6ffd477` | Parent: Resource Capacity Management ("Perform Capacity Management for Resources"). Evidence: App Availability. |

#### DE.CM Continuous Monitoring

> Assets are monitored to find anomalies, indicators of compromise, and other potentially adverse events

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **DE.CM-01** Networks and network services are monitored to find potentially adverse events | AC-02, AU-12, CA-07, CM-03, SC-05, SC-07, SI-04 | Security Monitoring & Detection `93773c1d`; Network Security `6306e23c` | Parent: Security Monitoring & Detection ("Central SIEM with alerting"); Network Security provides the monitored boundary. Evidence: Monitoring & Alerting. |
| **DE.CM-02** The physical environment is monitored to find potentially adverse events | CA-07, PE-03, PE-06, PE-20 | Physical Access Control `676d93db` | Parent: Physical Access Control. Evidence: Office Access & Door Monitoring, Visitor Control. |
| **DE.CM-03** Personnel activity and technology usage are monitored to find potentially adverse events | AC-02, AU-12, AU-13, CA-07, CM-10, CM-11 | Security Monitoring & Detection `93773c1d`; Utility Tool monitoring `5eb89158` | Parent: Security Monitoring & Detection for personnel activity; Utility Tool monitoring "Audits the execution of privileged program". Evidence: Utility Monitoring. |
| **DE.CM-06** External service provider activities and services are monitored to find potentially adverse events | CA-07, PS-07, SA-04, SA-09, SI-04 | Supplier & Third-Party Security `ffb17d27`; Security Monitoring & Detection `93773c1d` | Parent: Supplier & Third-Party Security ("ongoing monitoring") for provider oversight; Security Monitoring & Detection for their activity in the environment. |
| **DE.CM-09** Computing hardware and software, runtime environments, and their data are monitored to find potentially adverse events | AC-04, AC-09, AU-12, CA-07, CM-03, CM-06, CM-10, CM-11, SC-34, SC-35, SI-04, SI-07 | Security Monitoring & Detection `93773c1d`; Endpoint Protection `669076cc`; Security Logging `b4c2c4d8` | Parent: Security Monitoring & Detection, Endpoint Protection and Security Logging together cover hardware, software, runtime and data monitoring. |

#### DE.AE Adverse Event Analysis

> Anomalies, indicators of compromise, and other potentially adverse events are analyzed to characterize the events and detect cybersecurity incidents

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **DE.AE-02** Potentially adverse events are analyzed to better understand associated activities | AU-06, CA-07, IR-04, SI-04 | Security Monitoring & Detection `93773c1d`; Security Incident Management `03d6bee8` | Parent: Security Monitoring & Detection for analysis; Security Incident Management for escalation. Evidence: Monitoring & Alerting, Incident Response. |
| **DE.AE-03** Information is correlated from multiple sources | AU-06, CA-07, IR-04, IR-05, IR-08, PM-16, SI-04 | Security Monitoring & Detection `93773c1d` | Parent: Security Monitoring & Detection; correlation across sources is what a "Central SIEM" does. |
| **DE.AE-04** The estimated impact and scope of adverse events are understood | PM-09, PM-11, PM-18, PM-28, PM-30 | Security Incident Management `03d6bee8` | Parent: Security Incident Management. Its Incident Response & Breach Notification policy requires that incidents are "identified, contained, reported, and resolved quickly"; impact and scope estimation is procedure content. Judgment mapping. |
| **DE.AE-06** Information on adverse events is provided to authorized staff and tools | IR-04, PM-15, PM-16, RA-03, RA-04, RA-10 | Security Monitoring & Detection `93773c1d`; Security Incident Management `03d6bee8` | Parent: Security Monitoring & Detection ("alerting") and Security Incident Management, whose policy assigns an "Incident Commander, Technical Lead, Communications Lead, and Scribe". |
| **DE.AE-07** Cyber threat intelligence and other contextual information are integrated into the analysis | PM-16, RA-03, RA-10 | Threat intelligence `b777e529`; Security Monitoring & Detection `93773c1d` | Parent: Threat intelligence and Security Monitoring & Detection. Integration is evidenced by the Threat Intelligence Review task (new), which records "how intelligence is fed into monitoring and event analysis". Judgment mapping. |
| **DE.AE-08** Incidents are declared when adverse events meet the defined incident criteria | IR-04, IR-08 | Security Incident Management `03d6bee8` | Parent: Security Incident Management ("Establish an Incident Management Policy and Procedures"); declaration criteria belong in those procedures. Judgment mapping. |

#### RS.MA Incident Management

> Responses to detected cybersecurity incidents are managed

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **RS.MA-01** The incident response plan is executed in coordination with relevant third parties once an incident is declared | IR-06, IR-07, IR-08, SR-03, SR-08 | Security Incident Management `03d6bee8` | Parent: Security Incident Management. Evidence: Incident Response. Coordination with suppliers is mapped separately at GV.SC-08 through the supply chain program; this row does not claim it. Judgment mapping. |
| **RS.MA-02** Incident reports are triaged and validated | IR-04, IR-05, IR-06 | Security Incident Management `03d6bee8` | Parent: Security Incident Management; its policy requires incidents to be "identified, contained, reported, and resolved quickly". Triage detail is procedure content. Judgment mapping. |
| **RS.MA-03** Incidents are categorized and prioritized | IR-04, IR-05, IR-06 | Security Incident Management `03d6bee8` | Parent: Security Incident Management; categorization and prioritization are procedure content under the same policy. Judgment mapping. |
| **RS.MA-04** Incidents are escalated or elevated as needed | IR-04, IR-05, IR-06, IR-07 | Security Incident Management `03d6bee8` | Parent: Security Incident Management; its policy states that mishandled incidents "escalate to executive review". General severity-based escalation is procedure content. Judgment mapping. |
| **RS.MA-05** The criteria for initiating incident recovery are applied | IR-04, IR-08 | Security Incident Management `03d6bee8`; Disaster Recovery Planning `ae323c9f` | Parent: Security Incident Management and Disaster Recovery Planning, whose policy requires "Define DR trigger thresholds; an Incident Commander authorises activation and coordinates restoration". |

#### RS.AN Incident Analysis

> Investigations are conducted to ensure effective response and support forensics and recovery activities

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **RS.AN-03** Analysis is performed to establish what has taken place during an incident and the root cause of the incident | AU-07, IR-04, SI-02(07) | Security Incident Management `03d6bee8`; Continual Improvement & Corrective Action `1f0b8445` | Parent: Security Incident Management, whose policy requires "a root-cause post-mortem within 10 business days"; Continual Improvement & Corrective Action "performs root-cause analysis". |
| **RS.AN-06** Actions performed during an investigation are recorded, and the records' integrity and provenance are preserved | AU-07, IR-04, IR-06 | Security Incident Management `03d6bee8`; Security Logging `b4c2c4d8` | Parent: Security Incident Management, whose policy says "Preserve logs and evidence; record containment start/stop and recovery steps"; Security Logging supplies the records. Provenance handling beyond preservation is not stated. Judgment mapping. |
| **RS.AN-07** Incident data and metadata are collected, and their integrity and provenance are preserved | AU-07, IR-04, IR-06 | Security Logging `b4c2c4d8`; Security Incident Management `03d6bee8` | Parent: Security Logging and Security Incident Management ("Preserve logs and evidence"). Provenance handling beyond preservation is not stated. Judgment mapping. |
| **RS.AN-08** An incident's magnitude is estimated and validated | IR-04, IR-08, RA-03, RA-07 | Security Incident Management `03d6bee8` | Parent: Security Incident Management; magnitude estimation is procedure content. Judgment mapping. |

#### RS.CO Incident Response Reporting and Communication

> Response activities are coordinated with internal and external stakeholders as required by laws, regulations, or policies

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **RS.CO-02** Internal and external stakeholders are notified of incidents | IR-04, IR-06, IR-07, SR-03, SR-08 | Incident & Recovery Communications (new); Security Incident Management `03d6bee8` | Parent: new Incident & Recovery Communications control ("who is notified"); the incident policy requires that "required notifications are issued on time". Evidence: Stakeholder Communication Plan (new). |
| **RS.CO-03** Information is shared with designated internal and external stakeholders | IR-04, IR-06, IR-07, SR-03, SR-08 | Incident & Recovery Communications (new); Regulatory Liaison `3fa5b7bc` | Parent: new communications control ("what is shared with designated internal and external stakeholders"); Regulatory Liaison ("Maintain Contact with Authorities") for regulators; the incident policy requires "customer/regulator notices within applicable legal timeframes". |

#### RS.MI Incident Mitigation

> Activities are performed to prevent expansion of an event and mitigate its effects

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **RS.MI-01** Incidents are contained | IR-04 | Security Incident Management `03d6bee8` | Parent: Security Incident Management; its policy section "Containment & Eradication" requires "Isolate affected systems within 30 minutes of confirmation". |
| **RS.MI-02** Incidents are eradicated | IR-04 | Security Incident Management `03d6bee8`; Vulnerability Management `72aba39a` | Parent: Security Incident Management ("Containment & Eradication"); removing the exploited weakness is Vulnerability Management. |

#### RC.RP Incident Recovery Plan Execution

> Restoration activities are performed to ensure operational availability of systems and services affected by cybersecurity incidents

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **RC.RP-01** The recovery portion of the incident response plan is executed once initiated from the incident response process | CP-10, IR-04, IR-08 | Disaster Recovery Planning `ae323c9f`; Security Incident Management `03d6bee8` | Parent: Disaster Recovery Planning ("Test DR; meet RTO/RPO") executed when incident procedures invoke recovery. Evidence: Planning, Backup Restoration Test. |
| **RC.RP-02** Recovery actions are selected, scoped, prioritized, and performed | CP-10, IR-04, IR-08 | Disaster Recovery Planning `ae323c9f`; Business Continuity & ICT Readiness `c12ae932` | Parent: Disaster Recovery Planning ("Test DR; meet RTO/RPO") and Business Continuity & ICT Readiness ("BIA, continuity strategy") supply the prioritization inputs; selection and performance of recovery actions is procedure content. Judgment mapping. |
| **RC.RP-03** The integrity of backups and other restoration assets is verified before using them for restoration | CP-02, CP-04, CP-09 | Disaster Recovery Planning `ae323c9f`; Security Incident Management `03d6bee8` | Parent: Disaster Recovery Planning. Evidence: Backup Restoration Test (CSF-scoped) demonstrates backups restore correctly; a pre-use check during an actual recovery is procedure content. Judgment mapping. |
| **RC.RP-04** Critical mission functions and cybersecurity risk management are considered to establish post-incident operational norms | IR-01, IR-08, PM-08, PM-09, PM-11 | Business Continuity & ICT Readiness `c12ae932`; Disaster Recovery Planning `ae323c9f` | Parent: Business Continuity & ICT Readiness ("ICT readiness commitments per service tier") and Disaster Recovery Planning ("RTO/RPO") define recovery targets; post-incident operating norms that incorporate cybersecurity risk are not stated. Judgment mapping. |
| **RC.RP-05** The integrity of restored assets is verified, systems and services are restored, and normal operating status is confirmed | CP-10 | Disaster Recovery Planning `ae323c9f`; Security Incident Management `03d6bee8` | Parent: Disaster Recovery Planning for restoration and Security Incident Management for closure. Verification of restored-asset integrity and confirmation of normal operation are not stated by either. Judgment mapping. |
| **RC.RP-06** The end of incident recovery is declared based on criteria, and incident-related documentation is completed | IR-04, IR-08 | Security Incident Management `03d6bee8`; Continual Improvement & Corrective Action `1f0b8445` | Parent: Security Incident Management, whose policy requires a "Post-Incident Review & Lessons Learned"; Continual Improvement & Corrective Action tracks the outcomes. Declaration criteria are procedure content. Judgment mapping. |

#### RC.CO Incident Recovery Communication

> Restoration activities are coordinated with internal and external parties

| Subcategory (NIST CSF 2.0 text) | NIST informative refs (SP 800-53 Rev 5, union of 5.1.1 and 5.2.0 entries) | Comp controls | Rationale |
|---|---|---|---|
| **RC.CO-03** Recovery activities and progress in restoring operational capabilities are communicated to designated internal and external stakeholders | IR-04, IR-06, SR-08 | Incident & Recovery Communications (new); Disaster Recovery Planning `ae323c9f` | Parent: new communications control ("how recovery progress is reported"), exercised during Disaster Recovery Planning. Evidence: Stakeholder Communication Plan (new). |
| **RC.CO-04** Public updates on incident recovery are shared using approved methods and messaging | CP-02, IR-04 | Incident & Recovery Communications (new) | Parent: new communications control ("approved methods and messaging for public updates"). Evidence: Stakeholder Communication Plan (new). |
<!-- END GENERATED CROSSWALK -->

## 8. Risks and open points

- The mapping is judgment. A reviewer who disagrees with a row edits the crosswalk JSON, re-runs the generator, re-runs the seed (which reconciles CSF), and publishes a new version.
- 28 of 106 rows are judgment mappings where the outcome is carried by a task or policy clause or is procedure content. The rows themselves say which. Auditors assessing CSF alignment will need the procedure content in those cases.
- "Security Incident Management" is mapped 23 times (all of RS plus parts of DE and RC). Its policy contains the clauses cited, but the control is coarse; splitting it is possible later without changing this design.
- Moving the manifest builder into `packages/db` and changing the two backfills are divergences from upstream that merges must carry. The builder move is mechanical; the instance backfill change alters behaviour only for pinned instances.
- The shared organization-level control relations mean a task added for CSF on a shared control (for example Risk Management) is visible on that control in the organization regardless of framework. That is how Comp models shared controls; the instance-level links (what each framework page reports) stay isolated by 5.3.
- The two "Risk Management" controls are both named "Risk Management" in the UI; the crosswalk uses both deliberately (program vs formal process) and the UI shows their different descriptions.

## 9. Self-review record (revision 3)

- All ids resolve; generator validation passes with exact name equality (no trimming) for controls, policies and tasks.
- All 106 subcategory strings and reference lists are produced by the generator from the parsed export; the parsed export is compared to the workbook (texts and references) by the command in section 10.
- Every quoted span in every rationale is checked by the generator as an exact substring of a text belonging to a mapped control or its linked policies and tasks.
- Counts in sections 3 and 6 are produced by the commands in section 10 and by the generator.
- No em dashes, no TBD/TODO.

## 10. Verification commands

Run from the repository root.

```bash
# Parsed export vs workbook: 106 live subcategories, texts equal, SP 800-53 reference lists equal (union of Rev 5.x entries incl. family-level), per-Function counts
python3 - <<'PY'
import json, re, openpyxl, collections, warnings
warnings.filterwarnings('ignore')
d = json.load(open('.local/sources/csf-2.0-core.json')); subs = {s['id']: s for s in d['subcategories']}
wb = openpyxl.load_workbook('.local/sources/csf-2.0-core.xlsx', read_only=True)
live, refs = {}, collections.defaultdict(set)
for row in list(wb['CSF 2.0'].iter_rows(values_only=True))[2:]:
    cells = (list(row) + [None] * 5); s, r = cells[2], cells[4] or ''
    if s:
        m = re.match(r'^([A-Z]{2}\.[A-Z]{2}-\d\d): (.*)$', s, re.S)
        if not m.group(2).startswith('[Withdrawn'):
            live[m.group(1)] = m.group(2).strip()
            refs[m.group(1)] |= set(re.findall(r'^SP 800-53 Rev 5[\d.]*: ([A-Z]{2}(?:-\d+(?:\(\d+\))?)?)\s*$', r, re.M))
print(len(live), set(live) == set(subs), all(live[i] == subs[i]['text'] for i in live), all(sorted(refs[i]) == subs[i]['sp800_53'] for i in live), dict(collections.Counter(s['function'] for s in subs.values())))
PY

# Seed CSF rows: count, empty identifiers, trailing tabs, whitespace, raw and normalized description differences, category-name differences
python3 - <<'PY'
import json, re
d = json.load(open('.local/sources/csf-2.0-core.json')); subs = {s['id']: s for s in d['subcategories']}
seed = [r for r in json.load(open('packages/db/prisma/seed/primitives/FrameworkEditorRequirement.json')) if r['frameworkId'] == 'frk_6820090a1653380dd386c5eb']
byid = {re.match(r'^([A-Z]{2}\.[A-Z]{2}-\d\d)', r['name']).group(1): r for r in seed}
q = lambda t: t.replace('’', "'").replace('“', '"').replace('”', '"').strip()
h = lambda t: re.sub(r'\s+', ' ', re.sub('\\s*[-\\u2013\\u2014]\\s*', ' ', q(t))).lower()
print('rows', len(seed), '| ids match', set(byid) == set(subs), '| empty identifier', sum(r['identifier'] == '' for r in seed))
print('trailing tab names', sum(r['name'].endswith('\t') for r in seed), '| untrimmed descriptions', sum(r['description'] != r['description'].strip() for r in seed))
print('raw diffs', sum(byid[i]['description'] != subs[i]['text'] for i in subs), '| after trim+quotes', sum(q(byid[i]['description']) != q(subs[i]['text']) for i in subs), '| after hyphen/dash', [i for i in subs if h(byid[i]['description']) != h(subs[i]['text'])])
print('category-name diffs', sum(byid[i]['name'].split(' ', 1)[1].strip() != d['categories'][subs[i]['category']]['name'] for i in subs))
PY

# Relations: CSF has 0 control links; SOC 2 has 63 requirements, 121 links, 35 controls whose global links reach 25 distinct policies and 26 distinct tasks
python3 - <<'PY'
import json
S = 'packages/db/prisma/seed/'
req = json.load(open(S + 'primitives/FrameworkEditorRequirement.json'))
cr = json.load(open(S + 'relations/_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json'))
cp = json.load(open(S + 'relations/_FrameworkEditorControlTemplateToFrameworkEditorPolicyTemplate.json'))
ck = json.load(open(S + 'relations/_FrameworkEditorControlTemplateToFrameworkEditorTaskTemplate.json'))
csf = {x['id'] for x in req if x['frameworkId'] == 'frk_6820090a1653380dd386c5eb'}; soc = {x['id'] for x in req if x['frameworkId'] == 'frk_683f377429b8408d1c85f9bd'}
socc = {x['A'] for x in cr if x['B'] in soc}
print(sum(x['B'] in csf for x in cr), len(soc), sum(x['B'] in soc for x in cr), len(socc), len({x['B'] for x in cp if x['A'] in socc}), len({x['B'] for x in ck if x['A'] in socc}))
PY

# Template counts and duplicate names
python3 - <<'PY'
import json, collections
P = 'packages/db/prisma/seed/primitives/'
ct = json.load(open(P + 'FrameworkEditorControlTemplate.json')); pt = json.load(open(P + 'FrameworkEditorPolicyTemplate.json')); tt = json.load(open(P + 'FrameworkEditorTaskTemplate.json'))
dup = lambda rows: {n: c for n, c in collections.Counter(r['name'].strip() for r in rows).items() if c > 1}
print(len(ct), len(pt), len(tt), dup(ct), dup(tt))
PY

# Database state (this machine); saved output: .local/sources/db-state-2026-09-15.txt
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d comp -Atc "
select 'versions', f.name||' '||f.version, v.version, jsonb_array_length(v.manifest->'requirements'), jsonb_array_length(v.manifest->'controls'), (select count(*) from \"FrameworkInstance\" i where i.\"currentVersionId\"=v.id), (select count(*) from \"FrameworkSyncOperation\" s where s.\"fromVersionId\"=v.id or s.\"toVersionId\"=v.id) from \"FrameworkVersion\" v join \"FrameworkEditorFramework\" f on f.id=v.\"frameworkId\" where f.name in ('SOC 2','NIST CSF') order by 2,3;
select 'soc2_manifest_policy_task_ids', (select count(distinct p) from \"FrameworkVersion\" v, jsonb_array_elements(v.manifest->'controls') c, jsonb_array_elements_text(c->'policyIds') p where v.\"frameworkId\"='frk_683f377429b8408d1c85f9bd'), (select count(distinct t) from \"FrameworkVersion\" v, jsonb_array_elements(v.manifest->'controls') c, jsonb_array_elements_text(c->'taskIds') t where v.\"frameworkId\"='frk_683f377429b8408d1c85f9bd');
select 'scoped_editor_links_total', (select count(*) from \"FrameworkEditorControlPolicyTemplateLink\"), (select count(*) from \"FrameworkEditorControlTaskTemplateLink\"), (select count(*) from \"FrameworkEditorControlDocumentTypeLink\");
select 'instance_links', (select count(*) from \"FrameworkControlPolicyLink\"), (select count(*) from \"FrameworkControlTaskLink\"), (select count(*) from \"FrameworkControlDocumentTypeLink\");"

# Crosswalk validation (exact ids and names, coverage, policy/task coverage, exact attributed quotes) and section 6 numbers
python3 .local/gen-csf-spec.py
```

## 11. Review history

Round 1 (17 findings on revision 1), all addressed in revision 2: raw vs normalized counts; family-level SP 800-53 references; verbatim quotations; saved database snapshot; exact backfill and seed semantics; framework-scoped link model; `requirementFamily`/`sortOrder` in the manifest; `FrameworkSyncOperation` in the deletion precondition; reconciliation; ids instead of names; general-purpose tasks instead of narrowly scoped ones; `bun:test` and database tests; AICPA non-claim; rationale wording; overlooked existing controls; outcome-relevant evidence; complete verification commands.

Round 2 (verification of revision 2: 10 resolved, 7 incomplete, plus new items), addressed in revision 3:

- Seed mechanics: scoped links applied by a dedicated seed step instead of id-based primitives (loader ordering and composite-key collisions); the migration's version filter dropped deliberately and documented as a fork decision; CSF reconciliation made part of the seed with authority defined; instance-level backfill derived from the pinned manifest to prevent CSF evidence reaching SOC 2 instance links on reseed; one shared manifest builder so backfilled and published manifests cannot diverge; the "identical manifest" claim replaced by the precise statement about stored vs freshly built manifests.
- Source loader behaviour (latest published version pins new instances) added to section 3.
- Validator made exact (case-sensitive, no trimming) and attribution-aware; four rationales that named unlinked evidence now link it through CSF-scoped rows (Role-based Access Controls, Backup logs, Secure Code, Static Code Scanning).
- Rationales corrected: GV.RM-03, GV.RR-03, ID.AM-02, RC.RP-04, RC.RP-05 no longer overstate; GV.OC-01, GV.RM-01, ID.AM-03, ID.AM-07, ID.RA-08, PR.AT-02, DE.AE-07, RS.MA-01, RS.MA-04, RS.AN-06, RC.RP-02 now marked judgment; RS.MA-05 cites the DR policy clause; the CCPA-specific tabletop exercise is no longer cited; new task descriptions extended (mission in the Interested Parties Register, stakeholder agreement in the Risk Register).
- Qualified reuse of HIPAA/QMS-origin tasks stated; Asset Disposal & Sanitization Log distinguished from Secure Storage.
- Section 10 now also verifies reference lists, category-name differences and SOC 2 policy/task totals; the snapshot includes SOC 2's version and manifest counts.
