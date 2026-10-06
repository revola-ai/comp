import type { ErrorEvent } from '@sentry/nextjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scrubSensitiveHeaders } from './sentry-scrub';

const ORIGIN_SECRET = 'A'.repeat(64);

function eventWithHeaders(): ErrorEvent {
  return {
    type: undefined,
    request: {
      url: 'https://app.comp.revola.ai/org_1',
      headers: {
        'X-Comp-Origin-Auth': ORIGIN_SECRET,
        'x-internal-token': 'internal-test-token',
        'X-Comp-Forwarded-Auth': 'forwarded-test-token',
        'user-agent': 'test-agent',
      },
    },
    breadcrumbs: [
      {
        category: 'fetch',
        data: {
          url: 'http://comp-api.comp.internal:3333/v1/people',
          headers: { 'x-comp-origin-auth': ORIGIN_SECRET, accept: 'application/json' },
        },
      },
    ],
    contexts: {
      trace: {
        trace_id: 't',
        span_id: 's',
        data: {
          'http.request.header.x_comp_origin_auth': [ORIGIN_SECRET],
          'http.request.header.x_comp_forwarded_auth': ['forwarded-test-token'],
        },
      },
    },
    extra: { requestHeaders: { 'x-comp-origin-auth': ORIGIN_SECRET } },
  };
}

describe('scrubSensitiveHeaders', () => {
  it('removes the origin header (any case), the forwarded-IP token and the internal token', () => {
    const scrubbed = scrubSensitiveHeaders(eventWithHeaders());

    expect(JSON.stringify(scrubbed)).not.toContain('forwarded-test-token');
    expect(JSON.stringify(scrubbed)).not.toContain(ORIGIN_SECRET);
    expect(JSON.stringify(scrubbed)).not.toContain('internal-test-token');
    expect(JSON.stringify(scrubbed).toLowerCase()).not.toMatch(/x[-_]comp[-_]origin[-_]auth/);
  });

  it('keeps the other headers and fields intact', () => {
    const scrubbed = scrubSensitiveHeaders(eventWithHeaders());

    expect(scrubbed.request?.headers?.['user-agent']).toBe('test-agent');
    expect(scrubbed.request?.url).toBe('https://app.comp.revola.ai/org_1');
    expect(scrubbed.breadcrumbs?.[0]?.data?.headers).toEqual({ accept: 'application/json' });
  });

  it('handles an event without a request', () => {
    expect(scrubSensitiveHeaders({ type: undefined, message: 'boom' })).toEqual({
      type: undefined,
      message: 'boom',
    });
  });
});

describe('Sentry configs scrub before sending', () => {
  it.each(['sentry.server.config.ts', 'sentry.edge.config.ts'])('%s wires the scrubber', (file) => {
    const source = readFileSync(resolve(__dirname, '../..', file), 'utf8');
    expect(source).toMatch(/beforeSend:\s*scrubSensitiveHeaders/);
    expect(source).toMatch(/beforeSendTransaction:\s*scrubSensitiveHeaders/);
  });
});
