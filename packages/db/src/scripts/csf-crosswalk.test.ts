import { describe, expect, it } from 'bun:test';
import { loadCrosswalk, loadCsfCore, mintTemplateId, CSF_FRAMEWORK_ID } from './csf-crosswalk';

describe('csf-crosswalk loaders', () => {
  it('loads the official core with 106 subcategories in six functions', () => {
    const core = loadCsfCore();
    expect(core.subcategories).toHaveLength(106);
    expect(Object.keys(core.functions).sort()).toEqual(['DE', 'GV', 'ID', 'PR', 'RC', 'RS']);
    expect(Object.keys(core.categories)).toHaveLength(22);
  });

  it('loads a crosswalk that covers exactly the official subcategory ids', () => {
    const core = loadCsfCore();
    const crosswalk = loadCrosswalk();
    expect(crosswalk.frameworkId).toBe(CSF_FRAMEWORK_ID);
    const official = core.subcategories.map((s) => s.id).sort();
    const mapped = crosswalk.subcategories.map((s) => s.id).sort();
    expect(mapped).toEqual(official);
  });

  it('mints deterministic ids of the same shape as existing template ids', () => {
    const a = mintTemplateId({ prefix: 'frk_ct', name: 'Risk Appetite & Tolerance' });
    const b = mintTemplateId({ prefix: 'frk_ct', name: 'Risk Appetite & Tolerance' });
    expect(a).toBe(b);
    expect(a).toMatch(/^frk_ct_[0-9a-f]{24}$/);
  });
});
