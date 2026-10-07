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
  taskCount: number;
  newStatus: string;
  changedByName: string;
  organizationName: string;
  /** Undefined when the app URL is not configured: the email then has no button. */
  tasksUrl?: string;
}

export const TaskBulkStatusChangedEmail = ({
  toName,
  toEmail,
  taskCount,
  newStatus,
  changedByName,
  organizationName,
  tasksUrl,
}: Props) => {
  const unsubscribeUrl = getUnsubscribeUrl(toEmail);
  const taskText = taskCount === 1 ? 'task' : 'tasks';
  const statusText = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);

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
          {`${taskCount} ${taskText} status changed to ${statusText}`}
        </Preview>

        <Body className="mx-auto my-auto bg-[#fff] font-sans">
          <Container
            className="mx-auto my-[40px] max-w-[600px] border-transparent p-[20px] md:border-[#E8E7E1]"
            style={{ borderStyle: 'solid', borderWidth: 1 }}
          >
            <Logo />
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-[#121212]">
              Task Status Updated
            </Heading>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              Hello {toName},
            </Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              <strong>{changedByName}</strong> changed the status of{' '}
              <strong>
                {taskCount} {taskText}
              </strong>{' '}
              to <strong>{statusText}</strong> in{' '}
              <strong>{organizationName}</strong>.
            </Text>

            <CallToAction href={tasksUrl} label="View Tasks" />

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

export default TaskBulkStatusChangedEmail;
