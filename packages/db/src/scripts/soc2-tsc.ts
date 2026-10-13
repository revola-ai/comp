import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// "SOC 2" 1.0.0: the original SOC 2 framework, realigned to the official criteria by the
// crosswalk. Hidden from new customers, still backing orgs that instantiated it in 2025.
export const SOC2_LEGACY_FRAMEWORK_ID = 'frk_681ebae2f29f0ab08eb802ec';
// "SOC 2" 1: the SOC 2 framework offered to customers. Its requirement names carry the
// official criterion text; descriptions are Comp's implementation guidance.
export const SOC2_LIVE_FRAMEWORK_ID = 'frk_683f377429b8408d1c85f9bd';

const SEED_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'seed');
export const SOC2_CORE_PATH = path.join(SEED_DIR, 'crosswalks', 'soc2-tsc-2017-core.json');
export const SOC2_CROSSWALK_PATH = path.join(SEED_DIR, 'crosswalks', 'soc2-tsc-2017.json');

const criterionId = z.string().regex(/^(CC|A|C|PI|P)\d\.\d$/);

const coreSchema = z.object({
  source: z.string(),
  criteria: z.array(
    z.object({
      id: criterionId,
      family: z.string().min(1),
      series: z.string().min(1),
      text: z.string().min(1),
    }),
  ),
});

export const soc2CrosswalkSchema = z
  .object({
    frameworkId: z.literal(SOC2_LEGACY_FRAMEWORK_ID),
    source: z.string(),
    criteria: z.array(
      z.object({
        id: criterionId,
        requirementId: z.string().startsWith('frk_rq_'),
        // Label and text of the original record this criterion reuses; null for a record
        // created by the realignment.
        formerLabel: z.string().nullable(),
        formerText: z.string().optional(),
        rationale: z.string().min(1).optional(),
      }),
    ),
    retired: z.array(
      z.object({
        requirementId: z.string().startsWith('frk_rq_'),
        formerLabel: z.string(),
        formerText: z.string(),
        replacedBy: criterionId,
        rationale: z.string().min(1),
      }),
    ),
  })
  .superRefine((crosswalk, ctx) => {
    crosswalk.criteria.forEach((criterion, index) => {
      const renumbered = criterion.formerLabel !== null && criterion.formerLabel !== criterion.id;
      if (!renumbered || criterion.rationale) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${criterion.id} reuses the former ${criterion.formerLabel} record and needs a rationale`,
        path: ['criteria', index, 'rationale'],
      });
    });
    const mapped = new Set(crosswalk.criteria.map((criterion) => criterion.id));
    crosswalk.retired.forEach((record, index) => {
      if (mapped.has(record.replacedBy)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Retired ${record.formerLabel} is replaced by ${record.replacedBy}, which is not a mapped criterion`,
        path: ['retired', index, 'replacedBy'],
      });
    });
  });

export type Soc2Core = z.infer<typeof coreSchema>;
export type Soc2Crosswalk = z.infer<typeof soc2CrosswalkSchema>;

export function loadSoc2Core(): Soc2Core {
  return coreSchema.parse(JSON.parse(fs.readFileSync(SOC2_CORE_PATH, 'utf8')));
}

export function loadSoc2Crosswalk(): Soc2Crosswalk {
  return soc2CrosswalkSchema.parse(JSON.parse(fs.readFileSync(SOC2_CROSSWALK_PATH, 'utf8')));
}

/** Requirement id of the record each retired record's references move to. */
export function retiredReplacements({ crosswalk }: { crosswalk: Soc2Crosswalk }) {
  const requirementIdByCriterion = new Map(
    crosswalk.criteria.map((criterion) => [criterion.id, criterion.requirementId]),
  );
  return crosswalk.retired.map((record) => ({
    retiredId: record.requirementId,
    replacementId: requirementIdByCriterion.get(record.replacedBy)!,
  }));
}
