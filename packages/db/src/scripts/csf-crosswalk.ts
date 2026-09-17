import { EvidenceFormType } from '@prisma/client';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const CSF_FRAMEWORK_ID = 'frk_6820090a1653380dd386c5eb';

const SEED_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'seed');
export const CROSSWALK_PATH = path.join(SEED_DIR, 'crosswalks', 'nist-csf-2.0.json');
export const CORE_PATH = path.join(SEED_DIR, 'crosswalks', 'nist-csf-2.0-core.json');
export const PRIMITIVES_DIR = path.join(SEED_DIR, 'primitives');
export const RELATIONS_DIR = path.join(SEED_DIR, 'relations');

const subcategorySchema = z.object({
  id: z.string().regex(/^[A-Z]{2}\.[A-Z]{2}-\d{2}$/),
  category: z.string(),
  function: z.string(),
  text: z.string().min(1),
  sp800_53: z.array(z.string()),
  iso27001: z.array(z.string()),
});

const coreSchema = z.object({
  source: z.string(),
  functions: z.record(z.string(), z.object({ name: z.string(), text: z.string() })),
  categories: z.record(
    z.string(),
    z.object({ name: z.string(), function: z.string(), text: z.string() }),
  ),
  subcategories: z.array(subcategorySchema),
});

const controlRefSchema = z.object({ id: z.string(), name: z.string() });
const policyRefSchema = z.object({ id: z.string(), name: z.string() });
const taskRefSchema = z.object({ id: z.string(), name: z.string() });

export const crosswalkSchema = z
  .object({
    frameworkId: z.literal(CSF_FRAMEWORK_ID),
    source: z.string(),
    subcategories: z.array(
      z.object({
        id: z.string(),
        requirementId: z.string().startsWith('frk_rq_'),
        controls: z.array(controlRefSchema).min(1),
        rationale: z.string().min(1),
      }),
    ),
    newControls: z.array(
      z.object({
        id: z.string().startsWith('frk_ct_'),
        name: z.string(),
        description: z.string(),
        policies: z.array(policyRefSchema).min(1),
        tasks: z.array(taskRefSchema).min(1),
        documentTypes: z.array(z.enum(EvidenceFormType)).default([]),
      }),
    ),
    newTasks: z.array(
      z.object({
        id: z.string().startsWith('frk_tt_'),
        name: z.string(),
        description: z.string(),
        frequency: z.enum(['monthly', 'quarterly', 'yearly']),
        department: z.enum(['none', 'admin', 'gov', 'hr', 'it', 'itsm', 'qms']),
      }),
    ),
    csfLinks: z.object({
      policies: z.array(z.object({ controlTemplateId: z.string(), policyTemplateId: z.string() })),
      tasks: z.array(z.object({ controlTemplateId: z.string(), taskTemplateId: z.string() })),
    }),
  });

export type CsfCore = z.infer<typeof coreSchema>;
export type Crosswalk = z.infer<typeof crosswalkSchema>;

export function loadCsfCore(): CsfCore {
  return coreSchema.parse(JSON.parse(fs.readFileSync(CORE_PATH, 'utf8')));
}

export function loadCrosswalk(): Crosswalk {
  return crosswalkSchema.parse(JSON.parse(fs.readFileSync(CROSSWALK_PATH, 'utf8')));
}

export function mintTemplateId({
  prefix,
  name,
}: {
  prefix: 'frk_ct' | 'frk_tt';
  name: string;
}): string {
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

export function readJsonArray<T>(filePath: string): T[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${filePath} is not a JSON array`);
  return parsed as T[];
}

export function serializeJsonArray(rows: unknown[]): string {
  // Seed JSON files use 2-space indentation and end without a trailing newline
  return JSON.stringify(rows, null, 2);
}

export function writeJsonArray({ filePath, rows }: { filePath: string; rows: unknown[] }): void {
  fs.writeFileSync(filePath, serializeJsonArray(rows));
}
