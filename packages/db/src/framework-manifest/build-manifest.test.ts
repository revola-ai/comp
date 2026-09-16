import { describe, expect, it } from 'bun:test';
import { buildManifestFromFramework, type ManifestFrameworkSource } from './build-manifest';

const policyA = {
  id: 'frk_pt_a',
  name: 'Policy A',
  description: null,
  content: { type: 'doc' },
  frequency: 'yearly',
  department: 'gov',
};
const policyB = {
  id: 'frk_pt_b',
  name: 'Policy B',
  description: null,
  content: { type: 'doc' },
  frequency: null,
  department: null,
};
const taskZ = {
  id: 'frk_tt_z',
  name: 'Task Z',
  description: 'z',
  frequency: 'yearly',
  department: 'it',
};
const taskY = {
  id: 'frk_tt_y',
  name: 'Task Y',
  description: 'y',
  frequency: null,
  department: null,
};

function source(): ManifestFrameworkSource {
  return {
    id: 'frk_x',
    name: 'X',
    version: '2.0',
    description: 'desc',
    requirements: [
      {
        id: 'frk_rq_2',
        identifier: 'GV.OC-02',
        name: 'Organizational Context',
        description: 'second',
        requirementFamily: 'Govern',
        sortOrder: 1,
        controlTemplates: [
          {
            id: 'frk_ct_b',
            name: 'B',
            description: 'b',
            controlFamily: null,
            requirements: [
              { id: 'frk_rq_2' },
              { id: 'frk_rq_1' },
              { id: 'frk_rq_other_framework' },
            ],
            frameworkPolicyLinks: [{ policyTemplate: policyB }, { policyTemplate: policyA }],
            frameworkTaskLinks: [{ taskTemplate: taskZ }, { taskTemplate: taskY }],
            frameworkDocumentLinks: [{ formType: 'network-diagram' }, { formType: 'meeting' }],
          },
        ],
      },
      {
        id: 'frk_rq_1',
        identifier: 'GV.OC-01',
        name: 'Organizational Context',
        description: 'first',
        requirementFamily: 'Govern',
        sortOrder: 0,
        controlTemplates: [
          {
            id: 'frk_ct_b',
            name: 'B',
            description: 'b',
            controlFamily: null,
            requirements: [
              { id: 'frk_rq_2' },
              { id: 'frk_rq_1' },
              { id: 'frk_rq_other_framework' },
            ],
            frameworkPolicyLinks: [{ policyTemplate: policyA }, { policyTemplate: policyB }],
            frameworkTaskLinks: [{ taskTemplate: taskY }, { taskTemplate: taskZ }],
            frameworkDocumentLinks: [{ formType: 'meeting' }, { formType: 'network-diagram' }],
          },
        ],
      },
    ],
  };
}

describe('buildManifestFromFramework', () => {
  it('keeps requirement order as given and drops requirement ids from other frameworks', () => {
    const manifest = buildManifestFromFramework(source());
    expect(manifest.requirements.map((r) => r.id)).toEqual(['frk_rq_2', 'frk_rq_1']);
    expect(manifest.requirements[0]).toEqual({
      id: 'frk_rq_2',
      identifier: 'GV.OC-02',
      name: 'Organizational Context',
      description: 'second',
      requirementFamily: 'Govern',
      sortOrder: 1,
    });
    expect(manifest.controls[0]!.requirementIds).toEqual(['frk_rq_1', 'frk_rq_2']);
  });

  it('dedupes controls, policies and tasks and sorts every array by id', () => {
    const manifest = buildManifestFromFramework(source());
    expect(manifest.controls).toHaveLength(1);
    expect(manifest.controls[0]!.policyIds).toEqual(['frk_pt_a', 'frk_pt_b']);
    expect(manifest.controls[0]!.taskIds).toEqual(['frk_tt_y', 'frk_tt_z']);
    expect(manifest.controls[0]!.documentTypes).toEqual(['meeting', 'network-diagram']);
    expect(manifest.policies.map((p) => p.id)).toEqual(['frk_pt_a', 'frk_pt_b']);
    expect(manifest.tasks.map((t) => t.id)).toEqual(['frk_tt_y', 'frk_tt_z']);
  });

  it('is deterministic: two builds of the same source are deep-equal', () => {
    expect(buildManifestFromFramework(source())).toEqual(buildManifestFromFramework(source()));
  });

  it('records the framework header', () => {
    expect(buildManifestFromFramework(source()).framework).toEqual({
      id: 'frk_x',
      name: 'X',
      catalogVersion: '2.0',
      description: 'desc',
    });
  });
});
