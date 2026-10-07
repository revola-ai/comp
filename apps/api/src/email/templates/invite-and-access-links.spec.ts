import { renderToStaticMarkup } from 'react-dom/server';
import { AccessRequestNotificationEmail } from './access-request-notification';

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
