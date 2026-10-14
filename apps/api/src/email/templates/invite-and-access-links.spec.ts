import { renderToStaticMarkup } from 'react-dom/server';
import { AccessRequestNotificationEmail } from './access-request-notification';
import { InviteEmail } from './invite-member';

const URL_SET = 'https://app.comp.revola.ai/org_1/trust/access-requests';
const DEAD_ANCHOR = /<a(?![^>]*href=)[^>]*>/;

describe('access request notification links', () => {
  const render = (reviewUrl: string | undefined) =>
    renderToStaticMarkup(
      AccessRequestNotificationEmail({
        organizationName: 'Revola',
        requesterName: 'Jane',
        requesterEmail: 'jane@example.com',
        reviewUrl,
      }),
    );

  it('links the review button to the URL it is given', () => {
    expect(render(URL_SET)).toContain(`href="${URL_SET}"`);
  });

  it('renders no button and no dead link without a URL', () => {
    const html = render(undefined);
    expect(html).not.toContain('Review Request');
    expect(html).not.toMatch(DEAD_ANCHOR);
  });
});

describe('invite email copy', () => {
  const portalLink = 'https://portal.comp.revola.ai/org_1';

  it('points at the invite above when there is an invite link', () => {
    const html = renderToStaticMarkup(
      InviteEmail({
        organizationName: 'Revola',
        inviteLink: 'https://app.comp.revola.ai/invite/inv_1',
        portalLink,
      }),
    );
    expect(html).toContain('accepted your invite above');
    expect(html).toContain(`href="${portalLink}"`);
  });

  it('never mentions an invite above when the invite link is missing', () => {
    const html = renderToStaticMarkup(
      InviteEmail({ organizationName: 'Revola', portalLink }),
    );
    expect(html).not.toMatch(/invite above/i);
    expect(html).toContain(`href="${portalLink}"`);
    expect(html).not.toMatch(DEAD_ANCHOR);
  });
});
