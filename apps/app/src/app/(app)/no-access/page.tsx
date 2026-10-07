import { Header } from '@/components/header';
import { OrganizationSwitcher } from '@/components/organization-switcher';
import { serverApi } from '@/lib/api-server';
import type { OrganizationFromMe } from '@/types';
import { auth } from '@/utils/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { PortalHint } from './portal-hint';

interface AuthMeResponse {
  organizations: OrganizationFromMe[];
}

export default async function NoAccess() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session || !session.session.activeOrganizationId) {
    return redirect('/');
  }

  const [meRes, orgRes] = await Promise.all([
    serverApi.get<AuthMeResponse>('/v1/auth/me'),
    serverApi.get<{ id: string; name: string }>('/v1/organization'),
  ]);

  const organizations = meRes.data?.organizations ?? [];
  const currentOrg = orgRes.data ?? null;

  return (
    <div className="flex h-dvh flex-col">
      <Header organizationId={currentOrg?.id} hideChat={true} />
      <div className="bg-foreground/05 flex flex-1 flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <div className="flex flex-col text-center">
          <PortalHint />
          <p>Please select another organization or contact your organization administrator.</p>
        </div>
        <div>
          <OrganizationSwitcher organizations={organizations} organization={currentOrg} />
        </div>
      </div>
    </div>
  );
}
