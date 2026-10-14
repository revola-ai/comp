import type { NextFunction, Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLIENT_IP_HEADER,
  clientIpHeaderMiddleware,
} from './client-ip-header.middleware';

const ORIGIN = 'C'.repeat(64);

function run(req: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}): void {
  const next: NextFunction = jest.fn();
  clientIpHeaderMiddleware(
    req as unknown as Request,
    {} as unknown as Response,
    next,
  );
  expect(next).toHaveBeenCalledTimes(1);
}

describe('clientIpHeaderMiddleware (feeds better-auth its rate-limit key)', () => {
  const savedOrigin = process.env.COMP_ORIGIN_AUTH;
  beforeAll(() => {
    process.env.COMP_ORIGIN_AUTH = ORIGIN;
  });
  afterAll(() => {
    process.env.COMP_ORIGIN_AUTH = savedOrigin;
  });

  it('replaces a client-supplied value with the verified client IP', () => {
    const req = {
      ip: '10.0.1.20',
      headers: { [CLIENT_IP_HEADER]: '198.51.100.7' },
    };
    run(req);
    expect(req.headers[CLIENT_IP_HEADER]).toBe('10.0.1.20');
  });

  it('uses CF-Connecting-IP only with a valid origin header', () => {
    const forged = {
      ip: '10.0.1.20',
      headers: { 'cf-connecting-ip': '198.51.100.7' } as Record<
        string,
        string | undefined
      >,
    };
    run(forged);
    expect(forged.headers[CLIENT_IP_HEADER]).toBe('10.0.1.20');

    const verified = {
      ip: '10.0.1.20',
      headers: {
        'x-comp-origin-auth': ORIGIN,
        'cf-connecting-ip': '198.51.100.7',
      } as Record<string, string | undefined>,
    };
    run(verified);
    expect(verified.headers[CLIENT_IP_HEADER]).toBe('198.51.100.7');
  });

  it('removes the header when no client address is known', () => {
    const req = { headers: { [CLIENT_IP_HEADER]: '198.51.100.7' } };
    run(req);
    expect(req.headers[CLIENT_IP_HEADER]).toBeUndefined();
  });

  it('is the only header better-auth reads the client IP from', () => {
    const source = readFileSync(
      resolve(__dirname, '../auth/auth.server.ts'),
      'utf8',
    );
    expect(source).toMatch(/ipAddressHeaders:\s*\[CLIENT_IP_HEADER\]/);
  });

  it('runs before the better-auth handler in main.ts', () => {
    const source = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');
    expect(source).toMatch(/app\.use\(clientIpHeaderMiddleware\)/);
  });
});
