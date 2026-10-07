type Module = typeof import('./verified-headers');

/** A fresh copy of the module, so its once-per-process warning starts unsent. */
function freshModule(): Module {
  let mod: Module | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<Module>('./verified-headers');
  });
  if (!mod) throw new Error('verified-headers did not load');
  return mod;
}

describe('TRUSTED_EDGE_PROXY_IPS with invalid entries at runtime', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('warns once per process, naming the variable and the count, never the values', () => {
    const { isTrustedEdgePeer } = freshModule();
    const env = {
      TRUSTED_EDGE_PROXY_IPS: 'cloudflared, 10.9.9.300,172.30.0.10',
    };
    expect(isTrustedEdgePeer({ peer: '172.30.0.10', env })).toBe(true);
    expect(isTrustedEdgePeer({ peer: '172.30.0.10', env })).toBe(true);
    const other = { TRUSTED_EDGE_PROXY_IPS: 'tunnel-host' };
    expect(isTrustedEdgePeer({ peer: '172.30.0.10', env: other })).toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0].map(String).join(' ');
    expect(message).toContain('TRUSTED_EDGE_PROXY_IPS');
    expect(message).toContain('2 ');
    expect(message).not.toContain('cloudflared');
    expect(message).not.toContain('10.9.9.300');
    expect(message).not.toContain('172.30.0.10');
  });

  it('stays quiet for a valid or unset list', () => {
    const { isTrustedEdgePeer } = freshModule();
    const valid = { TRUSTED_EDGE_PROXY_IPS: '172.30.0.10, fd00:30::10' };
    isTrustedEdgePeer({ peer: '172.30.0.10', env: valid });
    isTrustedEdgePeer({ peer: '172.30.0.10', env: {} });
    expect(warn).not.toHaveBeenCalled();
  });
});
