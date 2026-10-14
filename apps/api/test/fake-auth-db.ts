type Method = (...args: unknown[]) => unknown;
type Delegates = Record<string, Record<string, Method>>;

const WRITES = new Set(['create', 'update', 'upsert']);

function defaultResult({
  method,
  args,
}: {
  method: string;
  args: unknown[];
}): unknown {
  const [first] = args;
  const data =
    typeof first === 'object' && first !== null && 'data' in first
      ? first.data
      : undefined;
  if (WRITES.has(method)) {
    return { id: 'fake_id', ...(typeof data === 'object' ? data : {}) };
  }
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method.endsWith('Many')) return { count: 0 };
  return null;
}

/**
 * A stand-in Prisma client for loading auth.server.ts in a spec: every model
 * delegate answers reads with nothing found and echoes writes, except the
 * methods given in `overrides`. Named mock* so jest.mock factories may use it.
 */
export function mockFakeDb(overrides: Delegates): unknown {
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== 'string') return undefined;
          const override = overrides[model]?.[method];
          if (override) return override;
          return (...args: unknown[]) =>
            Promise.resolve(defaultResult({ method, args }));
        },
      },
    );
  const client: object = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== 'string') return undefined;
        if (property === 'then') return undefined;
        if (property === '$transaction') {
          return (run: (tx: unknown) => unknown) =>
            Promise.resolve(run(client));
        }
        return delegate(property);
      },
    },
  );
  return client;
}
