// better-auth ships ESM only. Jest's module registry cannot load it, but
// Node's own require can (require(esm)), so specs that need the real library
// pass it through in a jest.mock factory:
//
//   jest.mock('better-auth/api', () =>
//     jest
//       .requireActual<typeof import('../../test/native-module')>(
//         '../../test/native-module',
//       )
//       .nativeModule('better-auth/api'),
//   );
//
// process.getBuiltinModule is used because jest replaces `node:module`'s
// createRequire with its own registry-backed require.
const { createRequire } = process.getBuiltinModule('node:module');

const nativeRequire = createRequire(__filename);

/** Loads `id` with Node's require, outside jest's module registry. */
export function nativeModule<T>(id: string): T {
  return nativeRequire(id);
}
