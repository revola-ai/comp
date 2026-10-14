import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

// Request throttling and the credential attempt limit exist only if they are
// wired: AppModule must import ThrottleModule (the global throttler guard and
// identity interceptor), and AuthModule must provide one AuthFailureLimiter
// and export it to the modules hosting PlatformAdminGuard.
//
// AuthModule is built by Nest for real. Its better-auth integration
// (@thallesp/nestjs-better-auth, ESM only) is replaced by an empty module and
// auth.server by an empty auth: neither takes part in this wiring.
jest.mock('@thallesp/nestjs-better-auth', () => {
  const { Module: NestModule } =
    jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
  @NestModule({})
  class BetterAuthStubModule {
    static forRoot() {
      return { module: BetterAuthStubModule };
    }
  }
  return { AuthModule: BetterAuthStubModule };
});
jest.mock('../auth/auth.server', () => ({ auth: { api: {} } }));
jest.mock('@db', () => ({ db: {} }));
jest.mock('@trycompai/auth', () => ({
  BUILT_IN_ROLE_PERMISSIONS: {},
  statement: {},
}));

import { AuthModule } from '../auth/auth.module';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { AuthFailureLimiter } from './auth-failure-limiter';

/** Identifiers listed in the `imports` array of the class's @Module decorator. */
function moduleImports({
  file,
  className,
}: {
  file: string;
  className: string;
}): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        const call = decorator.expression;
        if (!ts.isCallExpression(call)) continue;
        const [options] = call.arguments;
        if (!options || !ts.isObjectLiteralExpression(options)) continue;
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (property.name.getText(source) !== 'imports') continue;
          if (!ts.isArrayLiteralExpression(property.initializer)) continue;
          for (const element of property.initializer.elements) {
            if (ts.isIdentifier(element)) found.push(element.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('throttling wiring', () => {
  it('AppModule imports ThrottleModule and AuthModule', () => {
    const imports = moduleImports({
      file: resolve(__dirname, '..', 'app.module.ts'),
      className: 'AppModule',
    });
    expect(imports).toEqual(
      expect.arrayContaining(['ThrottleModule', 'AuthModule']),
    );
  });

  it('AuthModule shares one AuthFailureLimiter with a module hosting PlatformAdminGuard', async () => {
    @Module({ imports: [AuthModule], providers: [PlatformAdminGuard] })
    class AdminHostModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AdminHostModule],
    }).compile();

    const fromAuth = moduleRef.select(AuthModule).get(AuthFailureLimiter);
    const guard = moduleRef.select(AdminHostModule).get(PlatformAdminGuard);
    expect(fromAuth).toBeInstanceOf(AuthFailureLimiter);
    expect(Reflect.get(guard, 'attemptLimiter')).toBe(fromAuth);
  });
});
