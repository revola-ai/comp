import {
  Body,
  Container,
  Heading,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import { CallToAction } from '../components/call-to-action';
import { Footer } from '../components/footer';
import { Logo } from '../components/logo';
import { UnsubscribeLink } from '../components/unsubscribe-link';
import { publicBaseUrl } from '../lib/public-url';
import { getUnsubscribeUrl } from '../lib/unsubscribe';

interface Props {
  email: string;
  userName: string;
  organizationName: string;
  organizationId: string;
}

export const AllPolicyNotificationEmail = ({
  email,
  userName,
  organizationName,
  organizationId,
}: Props) => {
  const portalUrl = publicBaseUrl(['NEXT_PUBLIC_PORTAL_URL']);
  const link = portalUrl ? `${portalUrl}/${organizationId}` : undefined;
  const subjectText = 'Please review and accept the policies';

  return (
    <Html>
      <Tailwind>
        <head />
        <Preview>{subjectText}</Preview>

        <Body className="mx-auto my-auto bg-[#fff] font-sans">
          <Container
            className="mx-auto my-[40px] max-w-[600px] border-transparent p-[20px] md:border-[#E8E7E1]"
            style={{ borderStyle: 'solid', borderWidth: 1 }}
          >
            <Logo />
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-[#121212]">
              {subjectText}
            </Heading>

            <Text className="text-[14px] leading-[24px] text-[#121212]">Hi {userName},</Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              All policies have been published and require your review.
            </Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              Your organization <strong>{organizationName}</strong> requires all employees to review
              and accept these policies.
            </Text>

            <CallToAction href={link} label="Review & Accept Policies" />

            <br />
            <Section>
              <Text className="text-[12px] leading-[24px] text-[#666666]">
                This notification was intended for <span className="text-[#121212]">{email}</span>.
              </Text>
            </Section>

            <UnsubscribeLink email={email} unsubscribeUrl={getUnsubscribeUrl(email)} />

            <br />

            <Footer />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default AllPolicyNotificationEmail;
