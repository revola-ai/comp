import { isProductionDeployment } from './production-deployment';

// Laptops share the production database (D7), so code that writes
// deployment configuration into it must tell the production deployment
// apart from a laptop, not production data from test data.
describe('isProductionDeployment', () => {
  const deployed = {
    NODE_ENV: 'production',
    SELF_HOSTED: 'true',
    AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
  };

  it('is true for the deployed self-hosted API behind Cloudflare', () => {
    expect(isProductionDeployment({ env: deployed })).toBe(true);
  });

  it.each([
    [
      'a laptop (development, self-hosted, no cookie domain)',
      { NODE_ENV: 'development', SELF_HOSTED: 'true' },
    ],
    [
      'the production image run locally (no cookie domain)',
      { NODE_ENV: 'production', SELF_HOSTED: 'true' },
    ],
    ['a blank cookie domain', { ...deployed, AUTH_COOKIE_DOMAIN: '  ' }],
    [
      'a development build with the cookie domain',
      { ...deployed, NODE_ENV: 'development' },
    ],
    ['the test runner', { ...deployed, NODE_ENV: 'test' }],
    [
      'a deployment that is not self-hosted',
      { ...deployed, SELF_HOSTED: undefined },
    ],
    ['an empty environment', {}],
  ])('is false for %s', (_name, env) => {
    expect(isProductionDeployment({ env })).toBe(false);
  });
});
