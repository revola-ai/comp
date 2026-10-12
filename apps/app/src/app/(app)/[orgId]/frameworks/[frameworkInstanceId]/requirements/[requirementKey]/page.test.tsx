import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
vi.mock('@/lib/api-server', () => ({
  serverApi: { get: (url: string) => mockGet(url) },
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

// The header actions and controls table have their own coverage and pull in
// SWR/permissions; stub them so this test focuses on the header + description.
vi.mock('./components/RequirementControls', () => ({
  RequirementControls: () => <div data-testid="requirement-controls" />,
}));
vi.mock('./components/AddCustomControlSheet', () => ({
  AddCustomControlSheet: () => null,
}));
vi.mock('./components/LinkExistingControlSheet', () => ({
  LinkExistingControlSheet: () => null,
}));

import RequirementPage from './page';

const CSF_TEXT =
  'The organizational mission is understood and informs cybersecurity risk management';

interface RequirementFixture {
  identifier: string | null;
  name: string;
  description: string | null | undefined;
}

function mockApi(requirement: RequirementFixture) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/v1/frameworks/fi_1') {
      return Promise.resolve({ data: { framework: { name: 'NIST CSF 2.0' } } });
    }
    if (url === '/v1/frameworks/fi_1/requirements/req_1') {
      return Promise.resolve({
        data: {
          requirement: { id: 'req_1', kind: 'platform', ...requirement },
          relatedControls: [],
          tasks: [],
          evidenceSubmissions: [],
        },
      });
    }
    return Promise.resolve({ data: undefined });
  });
}

async function renderPage() {
  const ui = await RequirementPage({
    params: Promise.resolve({
      orgId: 'org_1',
      frameworkInstanceId: 'fi_1',
      requirementKey: 'req_1',
    }),
  });
  return render(ui);
}

function queryDescriptionHeading() {
  return screen.queryByRole('heading', { name: 'Description' });
}

describe('RequirementPage description', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the official requirement text from description below the header', async () => {
    mockApi({
      identifier: 'GV.OC-01',
      name: 'Organizational Context',
      description: CSF_TEXT,
    });

    await renderPage();

    expect(screen.getByText('Organizational Context')).toBeInTheDocument();
    expect(queryDescriptionHeading()).toBeInTheDocument();
    const description = screen.getByText(CSF_TEXT);
    // Sits above the related-controls list.
    expect(
      description.compareDocumentPosition(screen.getByTestId('requirement-controls')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('preserves line breaks and normalizes CRLF to LF', async () => {
    mockApi({
      identifier: 'CC1.1',
      name: 'Control Environment',
      description: 'First line.\r\nSecond line.\rThird line.',
    });

    await renderPage();

    const description = screen.getByText(/First line\./);
    expect(description.textContent).toBe('First line.\nSecond line.\nThird line.');
    expect(description.closest('.whitespace-pre-wrap')).not.toBeNull();
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '  \r\n\t '],
    ['null', null],
    ['undefined', undefined],
  ])('renders no description block when description is %s', async (_label, value) => {
    mockApi({ identifier: 'GV.OC-01', name: 'Organizational Context', description: value });

    await renderPage();

    expect(queryDescriptionHeading()).toBeNull();
    expect(screen.getByTestId('requirement-controls')).toBeInTheDocument();
  });

  it('does not repeat the description when it equals the subtitle (name)', async () => {
    mockApi({
      identifier: 'CC1.1',
      name: 'Control Environment',
      description: '  Control Environment \n',
    });

    await renderPage();

    expect(queryDescriptionHeading()).toBeNull();
    expect(screen.getAllByText('Control Environment')).toHaveLength(1);
  });

  it('does not repeat the description when it equals the title (no identifier)', async () => {
    mockApi({ identifier: null, name: 'Access Reviews', description: 'Access Reviews' });

    await renderPage();

    expect(queryDescriptionHeading()).toBeNull();
  });

  it('does not repeat the description when it equals the identifier title', async () => {
    mockApi({ identifier: 'A.5.1', name: 'Policies', description: 'A.5.1' });

    await renderPage();

    expect(queryDescriptionHeading()).toBeNull();
  });
});
