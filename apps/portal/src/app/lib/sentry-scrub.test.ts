import type { ErrorEvent } from '@sentry/nextjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scrubSensitiveHeaders } from './sentry-scrub';

const ORIGIN_SECRET = 'B'.repeat(64);

describe('scrubSensitiveHeaders (portal)', () => {
  it('removes the origin header and internal token anywhere in the event', () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        headers: {
          'x-comp-origin-auth': ORIGIN_SECRET,
          'X-Internal-Token': 'internal-test-token',
          accept: 'text/html',
        },
      },
      breadcrumbs: [{ data: { headers: { 'X-Comp-Origin-Auth': ORIGIN_SECRET } } }],
    };

    const scrubbed = scrubSensitiveHeaders(event);

    expect(JSON.stringify(scrubbed)).not.toContain(ORIGIN_SECRET);
    expect(JSON.stringify(scrubbed)).not.toContain('internal-test-token');
    expect(scrubbed.request?.headers).toEqual({ accept: 'text/html' });
  });
});

describe('portal Sentry configs scrub before sending', () => {
  it.each(['sentry.server.config.ts', 'sentry.edge.config.ts'])('%s wires the scrubber', (file) => {
    const source = readFileSync(resolve(__dirname, '../../..', file), 'utf8');
    expect(source).toMatch(/beforeSend:\s*scrubSensitiveHeaders/);
    expect(source).toMatch(/beforeSendTransaction:\s*scrubSensitiveHeaders/);
  });
});
