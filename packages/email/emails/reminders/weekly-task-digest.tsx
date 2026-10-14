import {
  Body,
  Container,
  Heading,
  Html,
  Link,
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
  userName: string;
  organizationName: string;
  organizationId: string;
  tasks: Array<{
    id: string;
    title: string;
  }>;
}

const getTaskCountMessage = (count: number) => {
  const plural = count !== 1 ? 's' : '';
  return `You have ${count} pending task${plural} that are not yet completed`;
};

export const WeeklyTaskDigestEmail = ({
  email,
  userName,
  organizationName,
  organizationId,
  tasks,
}: Props) => {
  const appUrl = publicBaseUrl(['NEXT_PUBLIC_APP_URL']);
  const tasksUrl = appUrl ? `${appUrl}/${organizationId}/tasks` : undefined;
  const taskCountMessage = getTaskCountMessage(tasks.length);

  return (
    <Html>
      <Tailwind>
        <head />
        <Preview>{taskCountMessage}</Preview>

        <Body className="mx-auto my-auto bg-[#fff] font-sans">
          <Container
            className="mx-auto my-[40px] max-w-[600px] border-transparent p-[20px] md:border-[#E8E7E1]"
            style={{ borderStyle: 'solid', borderWidth: 1 }}
          >
            <Logo />
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-[#121212]">
              Weekly Task Reminder
            </Heading>

            <Text className="text-[14px] leading-[24px] text-[#121212]">Hi {userName},</Text>

            <Text className="text-[14px] leading-[24px] text-[#121212]">
              {taskCountMessage} in <strong>{organizationName}</strong>:
            </Text>

            <Section className="my-[24px]">
              <ul className="list-disc pl-[20px]">
                {tasks.map((task) => (
                  <li key={task.id} className="text-[14px] leading-[28px] text-[#121212]">
                    {tasksUrl ? (
                      <Link
                        href={`${tasksUrl}/${task.id}`}
                        className="text-[#121212] underline hover:text-[#666666]"
                      >
                        {task.title}
                      </Link>
                    ) : (
                      task.title
                    )}
                  </li>
                ))}
              </ul>
            </Section>

            <CallToAction href={tasksUrl} label="View All Tasks" />

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

export default WeeklyTaskDigestEmail;
