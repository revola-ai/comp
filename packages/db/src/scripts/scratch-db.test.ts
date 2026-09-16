import { describe, expect, it } from 'bun:test';
import { isScratchDatabaseUrl } from './scratch-db';

describe('isScratchDatabaseUrl', () => {
  it('accepts a local database whose name ends in _test', () => {
    expect(isScratchDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/comp_test')).toBe(true);
    expect(isScratchDatabaseUrl('postgresql://postgres:postgres@localhost:5432/comp_test?schema=public')).toBe(true);
  });

  it('rejects the working database', () => {
    expect(isScratchDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/comp')).toBe(false);
  });

  it('rejects urls where "test" appears outside the database name', () => {
    expect(isScratchDatabaseUrl('postgresql://tester:pw@latest-db.internal:5432/comp')).toBe(false);
    expect(isScratchDatabaseUrl('postgresql://postgres:pw@127.0.0.1:5432/comp?application_name=test')).toBe(false);
  });

  it('rejects prod and staging hosts even with a _test database name', () => {
    expect(isScratchDatabaseUrl('postgresql://u:p@prod-db.example.com:5432/comp_test')).toBe(false);
    expect(isScratchDatabaseUrl('postgresql://u:p@staging.example.com:5432/comp_test')).toBe(false);
  });

  it('rejects empty and unparseable values', () => {
    expect(isScratchDatabaseUrl('')).toBe(false);
    expect(isScratchDatabaseUrl(undefined)).toBe(false);
    expect(isScratchDatabaseUrl('not a url')).toBe(false);
  });
});
