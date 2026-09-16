import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCrosswalk, loadCsfCore, mintTemplateId, CSF_FRAMEWORK_ID, readJsonArray, writeJsonArray, serializeJsonArray } from './csf-crosswalk';

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

  it('round-trips JSON arrays with correct formatting via writeJsonArray and readJsonArray', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csf-'));
    const filePath = path.join(tmpDir, 'test.json');
    const testData = [{ id: 'test-1', name: 'Test Item' }, { id: 'test-2', name: 'Another Item' }];
    try {
      writeJsonArray({ filePath, rows: testData });
      const readData = readJsonArray<{ id: string; name: string }>(filePath);
      expect(readData).toEqual(testData);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      expect(fileContent).toBe(serializeJsonArray(testData));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
