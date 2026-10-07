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

interface FailedTaskItem {
  title: string;
  url?: string;
  failedCount: number;
  totalCount: number;
}

interface Props {
  toName: string;
  toEmail: string;
  organizationName: string;
  /** Undefined when the app URL is not configured: the email then has no button. */
  tasksUrl?: string;
  tasks: FailedTaskItem[];
}

const MAX_DISPLAYED_TASKS = 15;

export const AutomationBulkFailuresEmail = ({
  toName,
  toEmail,
  organizationName,
  tasksUrl,
  tasks,
}: Props) => {
  const unsubscribeUrl = getUnsubscribeUrl(toEmail);
  const taskCount = tasks.length;
  const taskText = taskCount === 1 ? 'task' : 'tasks';
  const displayedTasks = tasks.slice(0, MAX_DISPLAYED_TASKS);
  const remainingCount = taskCount - displayedTasks.length;

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
        <Preview>{`${taskCount} ${taskText} with automation failures`}</Preview>

        <Body className="mx-auto my-auto bg-[#fff] font-sans">
          <Container
            className="mx-auto my-[40px] max-w-[600px] border-transparent p-[20px] md:border-[#E8E7E1]"
            style={{ borderStyle: 'solid', borderWidth: 1 }}
          >
            <Logo />
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-[#121212]">
              Automation Failures Summary
            </Heading>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              Hello {toName},
            </Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              Today's scheduled automations found failures in{' '}
              <strong>{taskCount}</strong> {taskText} in{' '}
              <strong>{organizationName}</strong>.
            </Text>

            <Section className="mt-[16px] mb-[16px]">
              {displayedTasks.map((task, index) => (
                <Text
                  key={index}
                  className="my-[4px] text-[14px] leading-[24px] text-[#121212]"
                >
                  {'• '}
                  {task.url ? (
                    <Link href={task.url} className="text-[#121212] underline">
                      {task.title}
                    </Link>
                  ) : (
                    task.title
                  )}{' '}
                  ({task.failedCount}/{task.totalCount} failed)
                </Text>
              ))}
              {remainingCount > 0 && (
                <Text className="my-[4px] text-[14px] leading-[24px] text-[#666666]">
                  and {remainingCount} more...
                </Text>
              )}
            </Section>

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

export default AutomationBulkFailuresEmail;
