import { Img, Section } from '@react-email/components';
import * as React from 'react';
import { appBaseUrl } from '../../utils/public-url';

/** The logo file the app serves (apps/app/public/email/logo.png). */
export const EMAIL_LOGO_PATH = '/email/logo.png';

/**
 * The email logo, served by this deployment's app. Never upstream's asset host, which
 * would see every open (and the reader's IP); without NEXT_PUBLIC_APP_URL there is no
 * image.
 */
export function Logo() {
  const appUrl = appBaseUrl();
  if (!appUrl) return null;
  return (
    <Section className="mt-[32px]">
      <Img
        src={`${appUrl}${EMAIL_LOGO_PATH}`}
        width="45"
        height="45"
        alt="Comp AI"
        className="mx-auto my-0 block"
      />
    </Section>
  );
}
