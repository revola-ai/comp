import { vi } from 'vitest';

// Stub `server-only` so modules that use the marker can still be imported
// in jsdom test runs (the package throws outside a react-server build by design).
vi.mock('server-only', () => ({}));
