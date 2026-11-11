import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import ToolsDropdown from '../ToolsDropdown';

const mockSetEnabled = jest.fn();
const mockConsent = { shown: true, enabled: false, pending: false };

jest.mock('~/hooks/Hindsight/useHindsightConsent', () => ({
  __esModule: true,
  default: (surface: unknown) => {
    mockSurface(surface);
    return { key: 'convo-1', setEnabled: mockSetEnabled, ...mockConsent };
  },
}));

const mockSurface = jest.fn();

/** Mirrors existing menu specs: render items through their own `render` when open. */
jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    PinIcon: () => null,
    VectorIcon: () => null,
    TooltipAnchor: (props: { render: unknown }) => props.render,
    DropdownPopup: (props: {
      isOpen: boolean;
      setIsOpen: (open: boolean) => void;
      trigger: unknown;
      items: Array<{ onClick?: () => void; render?: (p: object) => unknown }>;
    }) =>
      R.createElement(
        'div',
        null,
        R.createElement('div', { onClick: () => props.setIsOpen(!props.isOpen) }, props.trigger),
        props.isOpen &&
          props.items.map((item, index) =>
            R.createElement(R.Fragment, { key: index }, item.render?.({ onClick: item.onClick })),
          ),
      ),
  };
});

jest.mock('@ariakit/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    MenuButton: (props: object & { children?: unknown }) =>
      R.createElement('button', props, props.children),
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => false,
  useAuthContext: () => ({ user: { id: 'owner' } }),
  useHasMemoryAccess: () => false,
  useAgentCapabilities: () => ({}),
  useGetAgentsConfig: () => ({ agentsConfig: { capabilities: ['tools'] } }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: {} }),
}));

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => ({ conversationId: 'convo-1' }),
}));

describe('ToolsDropdown Hindsight item', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockConsent, { shown: true, enabled: false, pending: false });
  });

  it('switches the chat through the consent hook as a model chat', async () => {
    render(<ToolsDropdown />);
    await userEvent.click(screen.getByLabelText('Tools Options'));
    const item = await screen.findByTestId('tools-menu-hindsight');
    expect(item).toHaveTextContent('com_ui_off');

    await userEvent.click(item);

    expect(mockSetEnabled).toHaveBeenCalledWith(true);
    expect(mockSurface).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'convo-1', kind: 'model', hidden: false }),
    );
  });

  it('shows the confirmed On state and switches it Off', async () => {
    mockConsent.enabled = true;
    render(<ToolsDropdown />);
    await userEvent.click(screen.getByLabelText('Tools Options'));
    const item = await screen.findByTestId('tools-menu-hindsight');
    expect(item).toHaveTextContent('com_ui_on');

    await userEvent.click(item);

    expect(mockSetEnabled).toHaveBeenCalledWith(false);
  });

  it('has no Hindsight item where the chat cannot use it', () => {
    mockConsent.shown = false;
    render(<ToolsDropdown />);

    /** With no other tools enabled the menu has nothing to show at all. */
    expect(screen.queryByLabelText('Tools Options')).toBeNull();
    expect(screen.queryByTestId('tools-menu-hindsight')).toBeNull();
  });
});
