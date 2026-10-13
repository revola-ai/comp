import { Section, Text } from '@trycompai/design-system';

interface RequirementDescriptionProps {
  description: string | null | undefined;
  /** Text already rendered in the page header (title, subtitle), used to avoid repeating it. */
  alreadyShown: Array<string | null | undefined>;
}

const normalizeLineBreaks = (text: string) => text.replace(/\r\n?/g, '\n');
const comparable = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The requirement's official text. For realigned frameworks (NIST CSF, SOC 2 TSC)
 * `name` holds the category and `description` the official criterion text, so it
 * is the content customers actually need to read on the detail page.
 */
export function RequirementDescription({ description, alreadyShown }: RequirementDescriptionProps) {
  const text = normalizeLineBreaks(description ?? '').trim();
  if (!text) return null;

  const key = comparable(text);
  const isDuplicate = alreadyShown.some((shown) => shown && comparable(shown) === key);
  if (isDuplicate) return null;

  return (
    <Section title="Description">
      <div className="max-w-prose whitespace-pre-wrap break-words">
        <Text size="sm" leading="relaxed">
          {text}
        </Text>
      </div>
    </Section>
  );
}
