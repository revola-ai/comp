import { Button, Section, Text } from '@react-email/components';
import * as React from 'react';

interface CallToActionProps {
  /** Undefined when the public URL it needs is not configured: the email then has no button. */
  href: string | undefined;
  label: string;
  /** Also print the URL for copying (default true). */
  showUrl?: boolean;
}

/** The main button of a notification email and its copy-and-paste URL, or nothing without a URL. */
export function CallToAction({
  href,
  label,
  showUrl = true,
}: CallToActionProps) {
  if (!href) return null;
  return (
    <>
      <Section className="mt-[32px] mb-[32px] text-center">
        <Button
          className="rounded-[3px] bg-[#121212] px-[20px] py-[12px] text-center text-[14px] font-semibold text-white no-underline"
          href={href}
        >
          {label}
        </Button>
      </Section>

      {showUrl && (
        <Text className="text-[14px] leading-[24px] text-[#121212]">
          or copy and paste this URL into your browser:{' '}
          <a href={href} className="text-[#121212] underline">
            {href}
          </a>
        </Text>
      )}
    </>
  );
}
