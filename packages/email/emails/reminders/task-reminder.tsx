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
import { CallToAction } from '../../components/call-to-action';
import { Footer } from '../../components/footer';
import { Logo } from '../../components/logo';
import { UnsubscribeLink } from '../../components/unsubscribe-link';
import { publicBaseUrl } from '../../lib/public-url';
import { getUnsubscribeUrl } from '../../lib/unsubscribe';

interface Props {
  email: string;
  name: string;
  dueDate: string;
  recordId: string;
}

export const TaskReminderEmail = ({ email, name, dueDate, recordId }: Props) => {
  const appUrl = publicBaseUrl(['NEXT_PUBLIC_APP_URL']);
  const link = appUrl ? `${appUrl}${recordId}` : undefined;

  return (
    <Html>
      <Tailwind>
        <head />
        <Preview>Comp AI - Task Reminder</Preview>

        <Body className="mx-auto my-auto bg-[#fff] font-sans">
          <Container
            className="mx-auto my-[40px] max-w-[600px] border-transparent p-[20px] md:border-[#E8E7E1]"
            style={{ borderStyle: 'solid', borderWidth: 1 }}
          >
            <Logo />
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-[#121212]">
              Task Reminder
            </Heading>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              Hey {name}, you're assigned to a task that is due soon ({dueDate}
              ).
            </Text>
            <CallToAction href={link} label="Open Task" />

            <br />
            <Section>
              <Text className="text-[12px] leading-[24px] text-[#666666]">
                this notification was intended for <span className="text-[#121212]">{email}</span>
                .{' '}
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

export default TaskReminderEmail;
