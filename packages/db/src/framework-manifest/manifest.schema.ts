// Minimal validated shape of a stored FrameworkVersion.manifest, covering only the fields the
// instance-links backfill (instance-links-from-manifests.ts) reads. Passthrough so the many
// manifest fields this backfill does not use (requirements, policies, tasks, etc.) are kept
// without being validated.

import { EvidenceFormType } from '@prisma/client';
import { z } from 'zod';

const formTypeSchema = z.enum(EvidenceFormType);

export const manifestControlSchema = z
  .object({
    id: z.string(),
    policyIds: z.array(z.string()),
    taskIds: z.array(z.string()),
    documentTypes: z.array(formTypeSchema).optional(),
  })
  .passthrough();

export const manifestSchema = z
  .object({
    controls: z.array(manifestControlSchema),
  })
  .passthrough();

export type ParsedManifest = z.infer<typeof manifestSchema>;
