import { ForbiddenException, Logger } from '@nestjs/common';
import { db } from '@db';
import { hasAppAccess } from './app-access';
import { auth } from './auth.server';
import type { AuthenticatedRequest } from './types';

const logger = new Logger('HybridAuthGuard');

/**
 * Resolve a hosted-MCP OAuth access token (issued by better-auth's mcp/oidc
 * provider and forwarded by the Gram-hosted MCP server). Populates the request
 * context and returns true on success; returns false when the bearer token is
 * not a valid MCP OAuth token (so the caller throws the generic 401). Throws
 * when no organization can be resolved.
 *
 * The token carries the user identity only. The organization is resolved
 * explicitly from the user's active memberships (device-agent style), never a
 * "most recent" guess. One org → used directly. Multiple orgs → the org the
 * user chose for MCP (McpOrgBinding, set at connect time) is used if they're
 * still a member; otherwise we ask them to choose rather than guess a tenant.
 * Roles come from the resolved member so the existing PermissionGuard enforces
 * RBAC unchanged.
 *
 * Two hard gates (both 403, never 401): the user must (1) be a member of an
 * organization at all - strangers who merely completed sign-in are rejected -
 * and (2) hold a role with app access (`app:read`) in the operative org, the
 * same rule the web app uses. Portal-only roles (employee/contractor) cannot
 * use the MCP.
 */
export async function authenticateMcpOAuth({
  request,
  headers,
}: {
  request: AuthenticatedRequest;
  headers: Headers;
}): Promise<boolean> {
  const token = await auth.api.getMcpSession({ headers }).catch(() => null);
  if (!token?.userId) {
    return false;
  }

  const userId = token.userId;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });
  if (!user) {
    return false;
  }

  request.userId = user.id;
  request.userEmail = user.email;
  request.userRoles = null;
  request.organizationId = '';
  request.authType = 'session';
  request.isApiKey = false;
  request.isServiceToken = false;
  request.isMcpOAuth = true;
  request.isPlatformAdmin = user.role === 'admin';

  // An MCP token is only usable by a member of at least one organization.
  // Enumerate active memberships up front (device-agent style) so a user with
  // none - e.g. someone who completed Google sign-in but was never invited to
  // any org, or who was removed from all of them - is blocked from EVERY MCP
  // tool, including the org-agnostic (skipOrgCheck) ones.
  const memberships = await db.member.findMany({
    where: { userId, deactivated: false },
    select: { id: true, role: true, department: true, organizationId: true },
  });

  if (memberships.length === 0) {
    // Authenticated, but a member of nothing - not an auth failure, so 403
    // (not 401) keeps the MCP client from looping on re-authentication.
    throw new ForbiddenException(
      'This account is not a member of any organization, so it cannot use the MCP.',
    );
  }

  let member = memberships[0];
  if (memberships.length > 1) {
    // Multi-org: use the org the user chose for MCP (set at connect time),
    // as long as they're still a member of it. No saved/valid choice → ask
    // them to pick rather than guessing a tenant.
    const binding = await db.mcpOrgBinding.findUnique({
      where: { userId },
      select: { organizationId: true },
    });
    const chosen = binding
      ? memberships.find((m) => m.organizationId === binding.organizationId)
      : undefined;
    if (!chosen) {
      // 403 (not 401): the token is valid - the user just needs to pick an
      // org. A 401 would make the MCP client re-run sign-in in a loop.
      throw new ForbiddenException(
        'This account belongs to multiple organizations. Choose your ' +
          'organization for AI/MCP access in Comp AI settings, then try again.',
      );
    }
    member = chosen;
  }

  // App-access gate: MCP follows the same rule as the web app - only roles
  // that grant app access (`app:read`) may use it. Portal-only roles
  // (employee/contractor, or custom roles without app access) are rejected.
  // Platform admins bypass this, consistent with PermissionGuard's own
  // isPlatformAdmin bypass on the normal session path.
  if (
    !request.isPlatformAdmin &&
    !(await hasAppAccess(member.organizationId, member.role))
  ) {
    throw new ForbiddenException(
      "Your role doesn't have access to the app, so it can't use the MCP. " +
        'Ask an organization admin for access.',
    );
  }

  request.organizationId = member.organizationId;
  request.memberId = member.id;
  request.memberDepartment = member.department;
  request.userRoles = member.role ? member.role.split(',') : null;

  logger.log(
    `MCP OAuth token authenticated for user ${user.id} (org ${member.organizationId})`,
  );
  return true;
}
