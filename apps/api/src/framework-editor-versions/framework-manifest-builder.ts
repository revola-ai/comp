import { NotFoundException } from '@nestjs/common';
import { db } from '@db';
import {
  buildManifestFromFramework,
  manifestFrameworkQuery,
  type FrameworkManifest,
} from '@trycompai/db';

export async function buildManifestForFramework(
  frameworkId: string,
): Promise<FrameworkManifest> {
  const framework = await db.frameworkEditorFramework.findUnique(
    manifestFrameworkQuery(frameworkId),
  );
  if (!framework) throw new NotFoundException('Framework not found');
  return buildManifestFromFramework(framework);
}
