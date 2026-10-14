import { APIError } from 'better-auth/api';
import { describeFailure } from './describe-failure';

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

/** The one sign-up rule shared by every entry point. */
async function maySignUp({
  email,
  allowedDomains,
  db,
}: {
  email: string;
  allowedDomains: readonly string[];
  db: InvitationLookup;
}): Promise<boolean> {
  if (allowedDomains.length === 0) return true;

  const domain = emailDomain(email);
  if (domain !== null && allowedDomains.includes(domain)) return true;

  const invited =
    domain !== null && (await hasPendingInvitation({ db, email }));
  return isEmailAllowed({
    email,
    allowedDomains,
    hasPendingInvitation: invited,
  });
}

/**
 * Throws `APIError('FORBIDDEN')` whose code and message are both
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
  if (await maySignUp({ email, allowedDomains, db })) return;
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

/** The slice of the Prisma client the sign-in email senders need. */
export interface SignUpLookup extends InvitationLookup {
  user: {
    findFirst(args: {
      where: { email: { equals: string; mode: 'insensitive' } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/** Whether a sign-in email may go to this address (see below). */
async function mayReceiveSignInEmail({
  email,
  allowedDomains,
  db,
}: {
  email: string;
  allowedDomains: readonly string[];
  db: SignUpLookup;
}): Promise<boolean> {
  if (allowedDomains.length === 0) return true;
  const existingUser = await db.user.findFirst({
    where: {
      email: { equals: email.trim().toLowerCase(), mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (existingUser !== null) return true;
  return maySignUp({ email, allowedDomains, db });
}

/**
 * Wraps a sign-in email sender (magic link, email OTP) so nothing is mailed
 * to a new address that may not create an account; existing users always get
 * theirs. A skipped address gets the same answer as a mailed one, at the same
 * time: the wrapper resolves at once and decides and sends in the background
 * (the API is a long-running server), so neither the lookups nor the send
 * show in the latency and it never reveals which outside addresses have an
 * account. A failure is logged by error name and code only, never the address
 * or the link or code, and not thrown. The account itself is refused by the
 * user.create hook (createEmailDomainAllowlistHook), which also gives OAuth
 * sign-ins their email_domain_not_allowed error.
 */
export function createAllowlistedEmailSender<
  Message extends { email: string },
>({
  env,
  db,
  send,
  logError = (line) => console.error(`[Auth] ${line}`),
}: {
  env: Env;
  db: SignUpLookup;
  send: (message: Message) => Promise<void>;
  logError?: (line: string) => void;
}): (message: Message) => Promise<void> {
  const allowedDomains = parseAllowedDomains({ env });

  const deliver = async (message: Message): Promise<void> => {
    const email = message.email;
    if (!(await mayReceiveSignInEmail({ email, allowedDomains, db }))) return;
    await send(message);
  };

  return (message) => {
    void deliver(message).catch((error: unknown) => {
      logError(`Sign-in email not sent: ${describeFailure(error)}`);
    });
    return Promise.resolve();
  };
}
