import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET api-keys/available-scopes lists only the scopes the caller can grant
// (an owner holds finding:read and finding:update, not finding:create), so the
// presets must work from that reduced list: "Full Access" selects exactly it.
const GRANTABLE = ['finding:read', 'finding:update', 'risk:read', 'apiKey:create'];

vi.mock('@/hooks/use-api-keys', () => ({
  useAvailableScopes: () => ({
    availableScopes: GRANTABLE,
    isLoading: false,
    error: null,
  }),
}));

type Props = { children?: ReactNode; onClick?: () => void };

vi.mock('@trycompai/design-system', () => ({
  Badge: ({ children }: Props) => <span>{children}</span>,
  Button: ({ children, onClick }: Props) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Checkbox: () => <input type="checkbox" readOnly />,
  Collapsible: ({ children }: Props) => <div>{children}</div>,
  CollapsibleContent: ({ children }: Props) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: Props) => <div>{children}</div>,
  Stack: ({ children }: Props) => <div>{children}</div>,
  Text: ({ children }: Props) => <span>{children}</span>,
}));

vi.mock('@trycompai/design-system/icons', () => ({
  ChevronRight: () => <span />,
}));

import { ScopeSelector } from './ScopeSelector';

describe('ScopeSelector with the caller-grantable scopes', () => {
  const onScopesChange = vi.fn();
  const onPresetChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWith = ({
    preset,
    selectedScopes,
  }: {
    preset: 'full' | 'read-only' | 'custom';
    selectedScopes: string[];
  }) =>
    render(
      <ScopeSelector
        preset={preset}
        onPresetChange={onPresetChange}
        selectedScopes={selectedScopes}
        onScopesChange={onScopesChange}
      />,
    );

  it('Full Access selects exactly the grantable scopes', () => {
    renderWith({ preset: 'full', selectedScopes: GRANTABLE });
    expect(onScopesChange).toHaveBeenCalledWith(GRANTABLE);
    expect(screen.getByText('4 of 4 permissions selected')).toBeInTheDocument();
  });

  it('Read Only selects the grantable read scopes', () => {
    renderWith({ preset: 'read-only', selectedScopes: [] });
    expect(onScopesChange).toHaveBeenCalledWith(['finding:read', 'risk:read']);
  });

  it('Custom lists only the resources and actions the caller can grant', () => {
    renderWith({ preset: 'custom', selectedScopes: [] });
    expect(screen.getByText('Findings')).toBeInTheDocument();
    expect(screen.getByText('Risks')).toBeInTheDocument();
    expect(screen.getByText('API Keys')).toBeInTheDocument();
    expect(screen.queryByText('Vendors')).not.toBeInTheDocument();
    expect(screen.getByText('Update')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});
