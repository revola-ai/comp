import { resolveServiceByToken } from './service-token.config';

const CURRENT = 'trigger-current-token-value-0001';
const PREVIOUS = 'trigger-previous-token-value-001';
const PORTAL = 'portal-current-token-value-00001';

describe('resolveServiceByToken', () => {
  const KEYS = [
    'SERVICE_TOKEN_TRIGGER',
    'SERVICE_TOKEN_TRIGGER_PREVIOUS',
    'SERVICE_TOKEN_TRIGGER_NEXT',
    'SERVICE_TOKEN_PORTAL',
    'SERVICE_TOKEN_PORTAL_PREVIOUS',
    'SERVICE_TOKEN_TRUST',
    'SERVICE_TOKEN_TRUST_PREVIOUS',
  ] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
    process.env.SERVICE_TOKEN_TRIGGER = CURRENT;
    process.env.SERVICE_TOKEN_PORTAL = PORTAL;
  });

  afterAll(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('accepts the current SERVICE_TOKEN_<NAME>', () => {
    expect(resolveServiceByToken(CURRENT)?.key).toBe('trigger');
    expect(resolveServiceByToken(PORTAL)?.key).toBe('portal');
  });

  it('accepts SERVICE_TOKEN_<NAME>_PREVIOUS when it is set, as the same service', () => {
    process.env.SERVICE_TOKEN_TRIGGER_PREVIOUS = PREVIOUS;
    const resolved = resolveServiceByToken(PREVIOUS);
    expect(resolved?.key).toBe('trigger');
    expect(resolved?.definition.name).toBe('Trigger.dev Workers');
    expect(resolveServiceByToken(CURRENT)?.key).toBe('trigger');
  });

  it('rejects the old token once SERVICE_TOKEN_<NAME>_PREVIOUS is unset', () => {
    expect(resolveServiceByToken(PREVIOUS)).toBeNull();
  });

  it('ignores an empty SERVICE_TOKEN_<NAME>_PREVIOUS', () => {
    process.env.SERVICE_TOKEN_TRIGGER_PREVIOUS = '';
    expect(resolveServiceByToken('')).toBeNull();
  });

  it('rejects tokens from any other variable name', () => {
    process.env.SERVICE_TOKEN_TRIGGER_NEXT = 'trigger-next-token-value-0000001';
    expect(
      resolveServiceByToken('trigger-next-token-value-0000001'),
    ).toBeNull();
  });

  it('rejects unknown, empty and prefix-only tokens', () => {
    expect(resolveServiceByToken('nope')).toBeNull();
    expect(resolveServiceByToken('')).toBeNull();
    expect(resolveServiceByToken(CURRENT.slice(0, -1))).toBeNull();
    expect(resolveServiceByToken(`${CURRENT}x`)).toBeNull();
  });

  it('maps a previous token to the service it belongs to', () => {
    process.env.SERVICE_TOKEN_PORTAL_PREVIOUS = PREVIOUS;
    expect(resolveServiceByToken(PREVIOUS)?.key).toBe('portal');
  });
});
