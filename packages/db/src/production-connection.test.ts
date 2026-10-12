import { describe, expect, it } from 'bun:test';
import { requiredProductionVerdict } from './production-connection';
import { hashProjectRef } from './production-target';

const REF = 'abcdefghijklmnopqrst';
const OTHER = 'zyxwvutsrqponmlkjihg';
const POOLER = 'aws-9-xx-test-1.pooler.supabase.com';
const TARGET = { projectRefSha256: hashProjectRef(REF), poolerHost: POOLER };
const PROD_POOLER_URL = `postgresql://postgres.${REF}:pw@${POOLER}:5432/postgres`;

function verdict(databaseUrl: string) {
  return requiredProductionVerdict({ databaseUrl, target: TARGET });
}

describe('requiredProductionVerdict', () => {
  it('is production when every ref named is production', () => {
    expect(verdict(PROD_POOLER_URL)).toBe('production');
    expect(verdict(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toBe(
      'production',
    );
    expect(verdict(`postgresql://postgres.${REF}:pw@db.${REF}.supabase.co:5432/postgres`)).toBe(
      'production',
    );
  });

  it('is not_production when no ref named is production', () => {
    expect(verdict(`postgresql://postgres.${OTHER}:pw@${POOLER}:5432/postgres`)).toBe(
      'not_production',
    );
    expect(verdict('postgresql://postgres:pw@127.0.0.1:5432/comp')).toBe('not_production');
  });

  it('is mixed when the user and the host name different projects', () => {
    expect(verdict(`postgresql://postgres.${REF}:pw@db.${OTHER}.supabase.co:5432/postgres`)).toBe(
      'mixed',
    );
  });

  it('is mixed when a ?user= override names another project (pg lets it replace the user)', () => {
    expect(verdict(`${PROD_POOLER_URL}?user=postgres.${OTHER}`)).toBe('mixed');
  });

  it('is mixed when a ?host= override names another project', () => {
    expect(verdict(`${PROD_POOLER_URL}?host=db.${OTHER}.supabase.co`)).toBe('mixed');
  });

  it('is unverifiable when the value is not a URL', () => {
    expect(verdict('not a url')).toBe('unverifiable');
  });
});
