import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { applySoc2Tsc } from './apply-soc2-tsc';
import { PRIMITIVES_DIR, RELATIONS_DIR, readJsonArray } from './csf-crosswalk';
import {
  SOC2_LEGACY_FRAMEWORK_ID,
  SOC2_LIVE_FRAMEWORK_ID,
  loadSoc2Core,
  loadSoc2Crosswalk,
  soc2CrosswalkSchema,
} from './soc2-tsc';

type Requirement = {
  id: string;
  frameworkId: string;
  name: string;
  identifier: string;
  description: string;
  requirementFamily?: string;
  sortOrder?: number;
};
type Pair = { A: string; B: string };

// Mis-decoded UTF-8 from text copied out of the AICPA PDF: a right single quote
// read as Mac Roman becomes "‚Äô", sometimes mangled to "‚" alone.
const MOJIBAKE = /‚|Äô/;

const core = loadSoc2Core();
const crosswalk = loadSoc2Crosswalk();
const requirements = readJsonArray<Requirement>(
  path.join(PRIMITIVES_DIR, 'FrameworkEditorRequirement.json'),
);
const officialById = new Map(core.criteria.map((criterion) => [criterion.id, criterion]));
const requirementsOf = (frameworkId: string) =>
  requirements.filter((requirement) => requirement.frameworkId === frameworkId);

describe('TSC 2017 core', () => {
  it('lists the 61 official criteria once each, Security first and Privacy last', () => {
    const ids = core.criteria.map((criterion) => criterion.id);
    expect(new Set(ids).size).toBe(61);
    expect(ids.slice(0, 2)).toEqual(['CC1.1', 'CC1.2']);
    expect(ids.at(-1)).toBe('P8.1');
    expect(ids.indexOf('CC9.2')).toBeLessThan(ids.indexOf('A1.1'));
  });
});

describe('SOC 2 1.0.0 crosswalk', () => {
  it('maps every official criterion to one requirement record', () => {
    expect(crosswalk.criteria.map((c) => c.id)).toEqual(core.criteria.map((c) => c.id));
    const ids = [...crosswalk.criteria, ...crosswalk.retired].map((c) => c.requirementId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accounts for all 74 original records', () => {
    const original = crosswalk.criteria.filter((c) => c.formerLabel !== null);
    expect(original.length + crosswalk.retired.length).toBe(74);
  });

  it('rejects a renumbered record without a rationale', () => {
    const renumbered = crosswalk.criteria.findIndex(
      (c) => c.formerLabel !== null && c.formerLabel !== c.id,
    );
    const criteria = crosswalk.criteria.map((c, index) =>
      index === renumbered ? { ...c, rationale: undefined } : c,
    );
    const result = soc2CrosswalkSchema.safeParse({ ...crosswalk, criteria });
    expect(result.success).toBe(false);
  });

  it('rejects a retired record whose replacement is not an official criterion', () => {
    const retired = crosswalk.retired.map((r, index) =>
      index === 0 ? { ...r, replacedBy: 'CC6.9' } : r,
    );
    const result = soc2CrosswalkSchema.safeParse({ ...crosswalk, retired });
    expect(result.success).toBe(false);
  });
});

describe(`SOC 2 1.0.0 (${SOC2_LEGACY_FRAMEWORK_ID}) seed requirements`, () => {
  const legacy = requirementsOf(SOC2_LEGACY_FRAMEWORK_ID);
  const legacyById = new Map(legacy.map((requirement) => [requirement.id, requirement]));

  it('are exactly the crosswalk records, with the official identifier, series, family, text and order', () => {
    const expected = crosswalk.criteria.map((c, index) => {
      const official = officialById.get(c.id)!;
      return {
        id: c.requirementId,
        identifier: c.id,
        name: official.series,
        description: official.text,
        requirementFamily: official.family,
        sortOrder: index,
      };
    });
    const actual = crosswalk.criteria.map((c) => {
      const row = legacyById.get(c.requirementId);
      return {
        id: row?.id,
        identifier: row?.identifier,
        name: row?.name,
        description: row?.description,
        requirementFamily: row?.requirementFamily,
        sortOrder: row?.sortOrder,
      };
    });
    expect(actual).toEqual(expected);
    expect(legacy).toHaveLength(61);
  });

  it('no longer contains retired records', () => {
    const retiredIds = new Set(crosswalk.retired.map((r) => r.requirementId));
    expect(requirements.filter((requirement) => retiredIds.has(requirement.id))).toEqual([]);
  });
});

describe(`SOC 2 1 (${SOC2_LIVE_FRAMEWORK_ID}) seed requirements`, () => {
  it('carry the official criterion wording as their name', () => {
    const wrong = requirementsOf(SOC2_LIVE_FRAMEWORK_ID)
      .filter((requirement) => requirement.name !== officialById.get(requirement.identifier)?.text)
      .map((requirement) => `${requirement.identifier} (${requirement.id})`);
    expect(wrong).toEqual([]);
  });
});

describe('FrameworkEditorRequirement seed', () => {
  it('has unique ids, since the seed upserts by id and a duplicate would overwrite silently', () => {
    const seen = new Set<string>();
    const duplicates = requirements.filter((r) => seen.size === seen.add(r.id).size);
    expect(duplicates.map((r) => r.id)).toEqual([]);
  });

  it('has no mojibake in any SOC 2 requirement', () => {
    const broken = [SOC2_LEGACY_FRAMEWORK_ID, SOC2_LIVE_FRAMEWORK_ID]
      .flatMap(requirementsOf)
      .filter((requirement) => MOJIBAKE.test(requirement.name + requirement.description))
      .map((requirement) => `${requirement.identifier} (${requirement.id})`);
    expect(broken).toEqual([]);
  });

  it('is what the generator produces from the crosswalk (crosswalk:soc2:check is clean)', () => {
    expect(applySoc2Tsc({ dryRun: true }).changedFiles).toEqual([]);
  });

  it('is referenced only by existing control templates and requirements', () => {
    const requirementIds = new Set(requirements.map((requirement) => requirement.id));
    const controlTemplateIds = new Set(
      readJsonArray<{ id: string }>(
        path.join(PRIMITIVES_DIR, 'FrameworkEditorControlTemplate.json'),
      ).map((template) => template.id),
    );
    const dangling = readJsonArray<Pair>(
      path.join(RELATIONS_DIR, '_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json'),
    ).filter((pair) => !requirementIds.has(pair.B) || !controlTemplateIds.has(pair.A));
    expect(dangling).toEqual([]);
  });
});
