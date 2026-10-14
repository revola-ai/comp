import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const API = 'http://comp-api.comp.internal:3333';
const fetchMock = vi.fn();

function exportFor(query: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost:3000/api/offboarding-export?${query}`));
}

describe('GET /api/offboarding-export', () => {
  beforeEach(() => {
    vi.stubEnv('BACKEND_API_URL', API);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('zip-bytes', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('exports one member through its encoded path', async () => {
    const response = await exportFor('memberId=mem_1');
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${API}/v1/offboarding-checklist/member/mem_1/export`,
    );
  });

  it('keeps a slash inside the member id segment', async () => {
    await exportFor(`memberId=${encodeURIComponent('a/b')}`);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${API}/v1/offboarding-checklist/member/a%2Fb/export`,
    );
  });

  for (const memberId of ['..', '.', '%2e%2e', '%2E.']) {
    it(`answers 400 for the dot segment ${memberId} and calls nothing`, async () => {
      const response = await exportFor(`memberId=${encodeURIComponent(memberId)}`);
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('answers 400 when neither memberId nor all=true is given', async () => {
    const response = await exportFor('');
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exports everyone with all=true', async () => {
    const response = await exportFor('all=true');
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/v1/offboarding-checklist/export-all`);
  });
});
