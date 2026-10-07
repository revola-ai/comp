import * as React from 'react';
import {
  Body,
  Button,
  Container,
  Font,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import { CallToAction } from '../components/call-to-action';
import { Footer } from '../components/footer';
import { Logo } from '../components/logo';
import { getUnsubscribeUrl } from '@trycompai/email';

interface Props {
  toName: string;
  toEmail: string;
  taskTitle: string;
  submittedByName: string;
  organizationName: string;
  /** Undefined when the app URL is not configured: the email then has no button. */
  taskUrl?: string;
}

export const EvidenceReviewRequestedEmail = ({
  toName,
  toEmail,
  taskTitle,
  submittedByName,
  organizationName,
  taskUrl,
}: Props) => {
  const unsubscribeUrl = getUnsubscribeUrl(toEmail);

  return (
    <Html>
      <Tailwind>
        <head>
          <Font
            fontFamily="Geist"
            fallbackFontFamily="Helvetica"
            fontWeight={400}
            fontStyle="normal"
          />
          <Font
            fontFamily="Geist"
            fallbackFontFamily="Helvetica"
            fontWeight={500}
            fontStyle="normal"
          />
        </head>
        <Preview>
          {`You've been requested to review evidence for "${taskTitle}"`}
        </Preview>

        <Body className="mx-auto my-auto bg-[#fff] font-sans">
          <Container
            className="mx-auto my-[40px] max-w-[600px] border-transparent p-[20px] md:border-[#E8E7E1]"
            style={{ borderStyle: 'solid', borderWidth: 1 }}
          >
            <Logo />
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-[#121212]">
              Evidence Review Requested
            </Heading>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              Hello {toName},
            </Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              <strong>{submittedByName}</strong> has submitted evidence for{' '}
              <strong>"{taskTitle}"</strong> and requested your approval in{' '}
              <strong>{organizationName}</strong>.
            </Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              Please review the evidence and approve or reject it.
            </Text>

            <CallToAction href={taskUrl} label="Review Evidence" />

            {unsubscribeUrl && (
              <Section className="mt-[30px] mb-[20px]">
                <Text className="text-[12px] leading-[20px] text-[#666666]">
                  Don't want to receive task assignment notifications?{' '}
                  <Link
                    href={unsubscribeUrl}
                    className="text-[#121212] underline"
                  >
                    Manage your email preferences
                  </Link>
                  .
                </Text>
              </Section>
            )}

            <br />

            <Footer />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default EvidenceReviewRequestedEmail;
