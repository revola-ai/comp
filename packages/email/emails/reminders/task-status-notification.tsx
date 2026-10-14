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
import { getUnsubscribeUrl } from '../../lib/unsubscribe';

interface Props {
  email: string;
  userName: string;
  taskName: string;
  taskStatus: 'failed' | 'todo';
  organizationName: string;
  /** Undefined when the app URL is not configured: the email then has no button. */
  taskUrl?: string;
}

export const TaskStatusNotificationEmail = ({
  email,
  userName,
  taskName,
  taskStatus,
  organizationName,
  taskUrl,
}: Props) => {
  const statusLabel = taskStatus === 'failed' ? 'Failed' : 'Needs Review';
  const statusMessage =
    taskStatus === 'failed'
      ? 'Your task has failed its automated checks and requires your attention.'
      : 'Your task is past its review date and needs to be reviewed.';

  return (
    <Html>
      <Tailwind>
        <head />
        <Preview>
          Task &quot;{taskName}&quot; {statusLabel} - {organizationName}
        </Preview>

        <Body className="mx-auto my-auto bg-[#fff] font-sans">
          <Container
            className="mx-auto my-[40px] max-w-[600px] border-transparent p-[20px] md:border-[#E8E7E1]"
            style={{ borderStyle: 'solid', borderWidth: 1 }}
          >
            <Logo />
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-[#121212]">
              Task {statusLabel}
            </Heading>

            <Text className="text-[14px] leading-[24px] text-[#121212]">Hello {userName},</Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              The task <strong>&quot;{taskName}&quot;</strong> in{' '}
              <strong>{organizationName}</strong> requires your attention.
            </Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">{statusMessage}</Text>

            <CallToAction href={taskUrl} label="View Task" />

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

export default TaskStatusNotificationEmail;
