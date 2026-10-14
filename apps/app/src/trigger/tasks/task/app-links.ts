import { publicBaseUrl } from '@trycompai/email';

// Links for scheduled task and policy notifications. Unset public URLs leave the link
// out (the email package warns once per process) instead of pointing recipients, with
// their organization and record ids, at upstream Comp's hosts.

export function appTaskUrl({
  organizationId,
  taskId,
}: {
  organizationId: string;
  taskId: string;
}): string | undefined {
  const appUrl = publicBaseUrl(['NEXT_PUBLIC_APP_URL']);
  return appUrl ? `${appUrl}/${organizationId}/tasks/${taskId}` : undefined;
}

export function appPolicyUrl({
  organizationId,
  policyId,
}: {
  organizationId: string;
  policyId: string;
}): string | undefined {
  const appUrl = publicBaseUrl(['NEXT_PUBLIC_APP_URL']);
  return appUrl ? `${appUrl}/${organizationId}/policies/${policyId}` : undefined;
}

export function portalPolicyUrl({
  organizationId,
  policyId,
}: {
  organizationId: string;
  policyId: string;
}): string | undefined {
  const portalUrl = publicBaseUrl(['NEXT_PUBLIC_PORTAL_URL']);
  return portalUrl ? `${portalUrl}/${organizationId}/policy/${policyId}` : undefined;
}
