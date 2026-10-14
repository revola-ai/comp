import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { EMAIL_LOGO_PATH, Logo } from './logo';

describe('email Logo', () => {
  const saved = process.env.NEXT_PUBLIC_APP_URL;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = saved;
  });

  it('loads the logo from this deployment, never upstream assets', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai/';
    const html = renderToStaticMarkup(Logo());
    expect(html).toContain('src="https://app.comp.revola.ai/email/logo.png"');
    expect(html).not.toContain('trycomp.ai');
  });

  it('renders no image without NEXT_PUBLIC_APP_URL', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(renderToStaticMarkup(Logo())).not.toContain('<img');
  });

  it('points at a file the app serves', () => {
    expect(EMAIL_LOGO_PATH).toBe('/email/logo.png');
    expect(
      existsSync(
        resolve(__dirname, '../../../../app/public', `.${EMAIL_LOGO_PATH}`),
      ),
    ).toBe(true);
  });
});
