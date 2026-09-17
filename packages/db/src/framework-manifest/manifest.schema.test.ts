import { describe, expect, it } from 'bun:test';
import { manifestSchema } from './manifest.schema';

describe('manifestSchema', () => {
  it('accepts a manifest whose controls carry documentTypes', () => {
    const manifest = {
      controls: [
        {
          id: 'frk_ct_a',
          policyIds: ['frk_pt_a'],
          taskIds: ['frk_tt_a'],
          documentTypes: ['infrastructure_inventory'],
        },
      ],
    };
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('accepts a manifest whose controls omit documentTypes', () => {
    const manifest = {
      controls: [{ id: 'frk_ct_a', policyIds: [], taskIds: [] }],
    };
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('rejects a manifest whose controls key is missing', () => {
    expect(() => manifestSchema.parse({})).toThrow();
  });

  it('rejects a manifest whose control carries an unknown document type', () => {
    const manifest = {
      controls: [{ id: 'frk_ct_a', policyIds: [], taskIds: [], documentTypes: ['not-a-real-type'] }],
    };
    expect(() => manifestSchema.parse(manifest)).toThrow();
  });

  it('passes through fields it does not validate', () => {
    const manifest = {
      framework: { id: 'frk_1', name: 'Test', catalogVersion: '1.0.0', description: null },
      controls: [{ id: 'frk_ct_a', policyIds: [], taskIds: [], extra: 'kept' }],
    };
    const parsed = manifestSchema.parse(manifest);
    expect(parsed).toEqual(manifest);
  });
});
