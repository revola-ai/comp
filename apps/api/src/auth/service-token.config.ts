import { timingSafeEqual } from 'crypto';

export interface ServiceDefinition {
  /** Environment variable holding the token */
  envVar: string;
  /** Human-readable name for audit logs */
  name: string;
  /** Allowed 'resource:action' pairs */
  permissions: string[];
}

/**
 * Service definitions for internal service-to-service authentication.
 * Each service gets its own token with explicit scoped permissions.
 */
export const SERVICE_DEFINITIONS: Record<string, ServiceDefinition> = {
  trigger: {
    envVar: 'SERVICE_TOKEN_TRIGGER',
    name: 'Trigger.dev Workers',
    permissions: [
      'integration:read',
      'integration:update',
      'cloud-security:update',
      'vendor:update',
      'email:send',
    ],
  },
  portal: {
    envVar: 'SERVICE_TOKEN_PORTAL',
    name: 'Portal App',
    permissions: ['training:read', 'training:update'],
  },
  trust: {
    envVar: 'SERVICE_TOKEN_TRUST',
    name: 'Trust Portal',
    permissions: [
      'trust:read',
      'organization:read',
      'questionnaire:read',
      'questionnaire:update',
    ],
  },
};

/** Suffix of the optional variable holding a service's previous token. */
export const PREVIOUS_TOKEN_SUFFIX = '_PREVIOUS';

function tokenMatches({
  presented,
  expected,
}: {
  presented: Buffer;
  expected: string | undefined;
}): boolean {
  if (!expected) return false;
  const expectedBuffer = Buffer.from(expected);
  return (
    presented.length === expectedBuffer.length &&
    timingSafeEqual(presented, expectedBuffer)
  );
}

/**
 * Resolve which service a token belongs to using timing-safe comparison.
 * Each service accepts its current token (`SERVICE_TOKEN_<NAME>`) and, while
 * a rotation is in progress, its previous one (`SERVICE_TOKEN_<NAME>_PREVIOUS`).
 * Returns the service key and definition, or null if no match.
 */
export function resolveServiceByToken(
  token: string,
): { key: string; definition: ServiceDefinition } | null {
  if (!token) return null;
  const presented = Buffer.from(token);

  for (const [key, definition] of Object.entries(SERVICE_DEFINITIONS)) {
    const current = process.env[definition.envVar];
    const previous = process.env[definition.envVar + PREVIOUS_TOKEN_SUFFIX];
    if (
      tokenMatches({ presented, expected: current }) ||
      tokenMatches({ presented, expected: previous })
    ) {
      return { key, definition };
    }
  }

  return null;
}

/**
 * Look up a service definition by its key name (e.g., 'trigger', 'portal').
 */
export function resolveServiceByName(
  name: string | undefined,
): ServiceDefinition | null {
  if (!name) return null;
  // Match by human-readable name (stored on request.serviceName)
  for (const definition of Object.values(SERVICE_DEFINITIONS)) {
    if (definition.name === name) return definition;
  }
  return null;
}
