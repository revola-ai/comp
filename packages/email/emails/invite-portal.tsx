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

interface Props {
  email: string;
  /** Undefined when the portal URL is not configured: the email then has no button. */
  inviteLink?: string;
  organizationName?: string;
}

export const InvitePortalEmail = ({ email, inviteLink, organizationName }: Props) => {
  return (
    <Html>
      <Tailwind>
        <head />
        <Preview>You've been invited to the Comp AI Portal</Preview>

        <Body className="mx-auto my-auto bg-[#fff] font-sans">
          <Container
            className="mx-auto my-[40px] max-w-[600px] border-transparent p-[20px] md:border-[#E8E7E1]"
            style={{ borderStyle: 'solid', borderWidth: 1 }}
          >
            <Logo />
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-[#121212]">
              You've been invited to the Comp AI Portal
            </Heading>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              {organizationName
                ? `${organizationName} has invited you to access their Comp AI Portal.`
                : "You've been invited to access the Comp AI Portal."}
            </Text>
            <CallToAction href={inviteLink} label="Accept Invitation" />

            <br />
            <Section>
              <Text className="text-[12px] leading-[24px] text-[#666666]">
                This invitation was intended for <span className="text-[#121212]">{email}</span>
                .{' '}
              </Text>
            </Section>

            <br />

            <Footer />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default InvitePortalEmail;
