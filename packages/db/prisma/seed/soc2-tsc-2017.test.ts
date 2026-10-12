import { describe, expect, it } from 'bun:test';
import controlTemplates from './primitives/FrameworkEditorControlTemplate.json';
import frameworks from './primitives/FrameworkEditorFramework.json';
import requirements from './primitives/FrameworkEditorRequirement.json';
import controlRequirementLinks from './relations/_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json';
import { SOC2_LEGACY_REMAP } from './soc2-legacy-remap';
import { TSC_2017_CRITERIA } from './soc2-tsc-2017';

// "SOC 2" 1.0.0 - the original SOC 2 framework. Hidden from new customers but
// still backing orgs that instantiated it while it was visible (May-June 2025).
const SOC2_LEGACY_FRAMEWORK_ID = 'frk_681ebae2f29f0ab08eb802ec';
// "SOC 2" 1 - the SOC 2 framework currently offered to customers.
const SOC2_LIVE_FRAMEWORK_ID = 'frk_683f377429b8408d1c85f9bd';

// Mis-decoded UTF-8 from text copied out of the AICPA PDF: "’" read as
// Mac Roman becomes "‚Äô", sometimes further mangled to "‚" alone.
const MOJIBAKE = /‚|Äô/;

const requirementsOf = (frameworkId: string) =>
  requirements.filter((requirement) => requirement.frameworkId === frameworkId);

const officialByIdentifier = new Map(
  TSC_2017_CRITERIA.map((criterion) => [criterion.identifier, criterion]),
);

describe('TSC 2017 reference list', () => {
  it('has the 61 official criteria, each once', () => {
    expect(TSC_2017_CRITERIA).toHaveLength(61);
    expect(officialByIdentifier.size).toBe(61);
  });
});

describe(`SOC 2 1.0.0 (${SOC2_LEGACY_FRAMEWORK_ID}) requirements`, () => {
  const legacy = requirementsOf(SOC2_LEGACY_FRAMEWORK_ID);

  it('is still defined, so existing framework instances keep resolving', () => {
    expect(frameworks.some((framework) => framework.id === SOC2_LEGACY_FRAMEWORK_ID)).toBe(true);
  });

  it('contains exactly the official criteria, each once', () => {
    const identifiers = legacy.map((requirement) => requirement.identifier).sort();
    const official = [...officialByIdentifier.keys()].sort();
    expect(identifiers).toEqual(official);
  });

  it('uses the official criterion wording as the description', () => {
    const mismatched = legacy
      .filter(
        (requirement) =>
          requirement.description !== officialByIdentifier.get(requirement.identifier)?.text,
      )
      .map((requirement) => `${requirement.identifier} (${requirement.id})`);
    expect(mismatched).toEqual([]);
  });

  it('names each requirement "<criterion> <official category>"', () => {
    const mismatched = legacy
      .filter((requirement) => {
        const criterion = officialByIdentifier.get(requirement.identifier);
        return requirement.name !== `${criterion?.identifier} ${criterion?.category}`;
      })
      .map((requirement) => `${requirement.id}: ${JSON.stringify(requirement.name)}`);
    expect(mismatched).toEqual([]);
  });

});

describe('SOC 2 1.0.0 legacy record remap', () => {
  const legacyById = new Map(
    requirementsOf(SOC2_LEGACY_FRAMEWORK_ID).map((requirement) => [requirement.id, requirement]),
  );
  const retained = SOC2_LEGACY_REMAP.filter((entry) => entry.action !== 'retired');
  const retired = SOC2_LEGACY_REMAP.filter((entry) => entry.action === 'retired');

  it('accounts for each of the 74 original records once, targeting an official criterion', () => {
    expect(new Set(SOC2_LEGACY_REMAP.map((entry) => entry.id)).size).toBe(74);
    const unknownTargets = SOC2_LEGACY_REMAP.filter(
      (entry) => !officialByIdentifier.has(entry.criterion),
    );
    expect(unknownTargets).toEqual([]);
  });

  it('labels an entry "kept" exactly when its number was already right', () => {
    const inconsistent = SOC2_LEGACY_REMAP.filter(
      (entry) => entry.action !== 'retired' && (entry.oldLabel === entry.criterion) !== (entry.action === 'kept'),
    );
    expect(inconsistent).toEqual([]);
  });

  it('keeps the record id of every retained record under its official criterion', () => {
    // Customer RequirementMap rows reference these ids (onDelete: Cascade), so
    // a retained record must never be re-created under a new id.
    const wrong = retained
      .filter((entry) => legacyById.get(entry.id)?.identifier !== entry.criterion)
      .map((entry) => `${entry.oldLabel} -> ${entry.criterion} (${entry.id})`);
    expect(wrong).toEqual([]);
  });

  it('removes retired records from the seed', () => {
    const stillPresent = retired.filter((entry) =>
      requirements.some((requirement) => requirement.id === entry.id),
    );
    expect(stillPresent).toEqual([]);
  });
});

describe(`SOC 2 1 (${SOC2_LIVE_FRAMEWORK_ID}) requirements`, () => {
  it('uses official criterion wording without mojibake', () => {
    const broken = requirementsOf(SOC2_LIVE_FRAMEWORK_ID)
      .filter(
        (requirement) => requirement.name !== officialByIdentifier.get(requirement.identifier)?.text,
      )
      .map((requirement) => `${requirement.identifier} (${requirement.id})`);
    expect(broken).toEqual([]);
  });
});

describe('seed requirement text', () => {
  it('has no mojibake in any SOC 2 requirement', () => {
    const soc2 = [SOC2_LEGACY_FRAMEWORK_ID, SOC2_LIVE_FRAMEWORK_ID].flatMap(requirementsOf);
    const broken = soc2
      .filter((requirement) => MOJIBAKE.test(requirement.name + requirement.description))
      .map((requirement) => `${requirement.identifier} (${requirement.id})`);
    expect(broken).toEqual([]);
  });
});

describe('control template <-> requirement relations', () => {
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const controlTemplateIds = new Set(controlTemplates.map((template) => template.id));

  it('only reference requirements that exist', () => {
    const dangling = controlRequirementLinks.filter((link) => !requirementIds.has(link.B));
    expect(dangling).toEqual([]);
  });

  it('only reference control templates that exist', () => {
    const dangling = controlRequirementLinks.filter((link) => !controlTemplateIds.has(link.A));
    expect(dangling).toEqual([]);
  });
});
