import { Button, Link, Section, Text } from '@react-email/components';

interface CallToActionProps {
  /** Undefined when the public URL it needs is not configured: the email then has no button. */
  href: string | undefined;
  label: string;
}

/** The main button of an email plus its copy-and-paste URL, or nothing without a URL. */
export function CallToAction({ href, label }: CallToActionProps) {
  if (!href) return null;
  return (
    <>
      <Section className="mt-[32px] mb-[42px] text-center">
        <Button
          className="text-primary border border-solid border-[#121212] bg-transparent px-6 py-3 text-center text-[14px] font-medium text-[#121212] no-underline"
          href={href}
        >
          {label}
        </Button>
      </Section>

      <Text className="text-[14px] leading-[24px] break-all text-[#707070]">
        or copy and paste this URL into your browser{' '}
        <Link href={href} className="text-[#707070] underline">
          {href}
        </Link>
      </Text>
    </>
  );
}
