import { env } from '@/env.mjs';
import { revalidatePath } from 'next/cache';
import { type NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Machine route called by Trigger.dev tasks (see `trigger/lib/revalidate-url.ts`).
 * It sits behind a Cloudflare Access Bypass, so this secret check is the only
 * gate: the secret must be configured and non-empty, it is compared in
 * constant time, and only an app-relative path can be revalidated.
 */

const credentialsSchema = z.object({ secret: z.string() });

const bodySchema = z.object({
  path: z
    .string()
    .regex(/^\/(?![/\\])/, 'path must be relative to the app, starting with a single /'),
  type: z.enum(['layout', 'page']).optional(),
});

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Hashing first gives equal-length buffers, so the comparison never leaks the length. */
function isValidSecret(provided: string): boolean {
  const expected = env.REVALIDATION_SECRET;
  if (!expected || !provided) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function POST(request: NextRequest) {
  const raw = await readJson(request);
  const credentials = credentialsSchema.safeParse(raw);

  if (!credentials.success || !isValidSecret(credentials.data.secret)) {
    return NextResponse.json({ message: 'Invalid secret' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { message: 'A relative path such as /org_123 is required' },
      { status: 400 },
    );
  }

  try {
    revalidatePath(parsed.data.path, parsed.data.type);
    return NextResponse.json({ revalidated: true });
  } catch (err) {
    console.error('Error revalidating path:', err);
    return NextResponse.json({ message: 'Error revalidating path' }, { status: 500 });
  }
}
