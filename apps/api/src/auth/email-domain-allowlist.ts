import { APIError } from 'better-auth/api';

type Env = Partial<NodeJS.ProcessEnv>;

/** Error code (and message) for a sign-up whose email domain is not allowed. */
export const EMAIL_DOMAIN_NOT_ALLOWED = 'email_domain_not_allowed';

const VARIABLE = 'AUTH_ALLOWED_EMAIL_DOMAINS';

// A bare DNS name with at least two labels, e.g. "revola.ai".
const DOMAIN_SHAPE =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Parse `AUTH_ALLOWED_EMAIL_DOMAINS` (comma-separated, e.g. "revola.ai").
 * Unset or blank means no restriction. A malformed entry throws so a typo
 * fails at boot instead of locking everyone out or letting everyone in.
 */
export function parseAllowedDomains({ env }: { env: Env }): string[] {
  const entries = (env[VARIABLE] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (!DOMAIN_SHAPE.test(entry)) {
      throw new Error(
        `${VARIABLE} contains "${entry}", which is not a domain. Example: ${VARIABLE}=revola.ai (comma-separated, no "@", no wildcards).`,
      );
    }
  }
  return entries;
}

/** Lowercased domain of a well-formed address, or null when malformed. */
function emailDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !DOMAIN_SHAPE.test(domain)) return null;
  return domain;
}

/**
 * Whether an email may create an account. An empty allowlist allows everyone;
 * otherwise the domain must be listed exactly (subdomains are not implied), or
 * the address must hold a pending invitation. Malformed emails never pass.
 */
export function isEmailAllowed({
  email,
  allowedDomains,
  hasPendingInvitation,
}: {
  email: string;
  allowedDomains: readonly string[];
  hasPendingInvitation: boolean;
}): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = emailDomain(email);
  if (!domain) return false;
  if (allowedDomains.includes(domain)) return true;
  return hasPendingInvitation;
}

/** The slice of the Prisma client the hook needs. */
export interface InvitationLookup {
  invitation: {
    findFirst(args: {
      where: {
        email: { equals: string; mode: 'insensitive' };
        status: 'pending';
        expiresAt: { gt: Date };
      };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

async function hasPendingInvitation({
  db,
  email,
}: {
  db: InvitationLookup;
  email: string;
}): Promise<boolean> {
  const invitation = await db.invitation.findFirst({
    where: {
      email: { equals: email.trim().toLowerCase(), mode: 'insensitive' },
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  return invitation !== null;
}

/**
 * The one sign-up check shared by every entry point: throws
 * `APIError('FORBIDDEN')` whose code and message are both
 * `email_domain_not_allowed` unless the email may create an account.
 */
async function assertSignUpAllowed({
  email,
  allowedDomains,
  db,
}: {
  email: string;
  allowedDomains: readonly string[];
  db: InvitationLookup;
}): Promise<void> {
  if (allowedDomains.length === 0) return;

  const domain = emailDomain(email);
  if (domain !== null && allowedDomains.includes(domain)) return;

  const invited =
    domain !== null && (await hasPendingInvitation({ db, email }));
  if (
    isEmailAllowed({ email, allowedDomains, hasPendingInvitation: invited })
  ) {
    return;
  }
  throw new APIError('FORBIDDEN', {
    code: EMAIL_DOMAIN_NOT_ALLOWED,
    message: EMAIL_DOMAIN_NOT_ALLOWED,
  });
}

/**
 * better-auth `databaseHooks.user.create.before` handler enforcing the
 * sign-up allowlist for every sign-up path (OAuth, magic link, email OTP).
 * The error message equals the code, so OAuth redirects carry it as `?error=`.
 */
export function createEmailDomainAllowlistHook({
  env,
  db,
}: {
  env: Env;
  db: InvitationLookup;
}): (user: { email: string }) => Promise<void> {
  const allowedDomains = parseAllowedDomains({ env });
  return (user) =>
    assertSignUpAllowed({ email: user.email, allowedDomains, db });
}

/** The slice of the Prisma client the magic-link sender needs. */
export interface SignUpLookup extends InvitationLookup {
  user: {
    findFirst(args: {
      where: { email: { equals: string; mode: 'insensitive' } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

export interface MagicLinkMessage {
  email: string;
  url: string;
}

/**
 * Wraps the magic-link `send` so a link that would create a disallowed
 * account is refused before anything is sent (the create hook would only
 * reject it at verify time). Existing users always get their link.
 */
export function createAllowlistedMagicLinkSender({
  env,
  db,
  send,
}: {
  env: Env;
  db: SignUpLookup;
  send: (message: MagicLinkMessage) => Promise<void>;
}): (message: MagicLinkMessage) => Promise<void> {
  const allowedDomains = parseAllowedDomains({ env });

  return async (message) => {
    if (allowedDomains.length > 0) {
      const existingUser = await db.user.findFirst({
        where: {
          email: {
            equals: message.email.trim().toLowerCase(),
            mode: 'insensitive',
          },
        },
        select: { id: true },
      });
      if (!existingUser) {
        await assertSignUpAllowed({ email: message.email, allowedDomains, db });
      }
    }
    await send(message);
  };
}
