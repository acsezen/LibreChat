import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import ToolsDropdown from '../ToolsDropdown';

const PIN_KEY = 'LAST_HINDSIGHT_TOGGLE_pinned';

/** A fresh jotai store per render, so the pin is read from localStorage like on page load. */
const renderMenu = () =>
  render(
    <Provider store={createStore()}>
      <ToolsDropdown />
    </Provider>,
  );

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
    localStorage.clear();
    Object.assign(mockConsent, { shown: true, enabled: false, pending: false });
  });

  it('switches the chat through the consent hook as a model chat', async () => {
    renderMenu();
    await userEvent.click(screen.getByLabelText('Tools Options'));
    const item = await screen.findByTestId('tools-menu-hindsight');

    await userEvent.click(item);

    expect(mockSetEnabled).toHaveBeenCalledWith(true);
    expect(mockSurface).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'convo-1', kind: 'model', hidden: false }),
    );
  });

  it('switches an On chat Off', async () => {
    mockConsent.enabled = true;
    renderMenu();
    await userEvent.click(screen.getByLabelText('Tools Options'));

    await userEvent.click(await screen.findByTestId('tools-menu-hindsight'));

    expect(mockSetEnabled).toHaveBeenCalledWith(false);
  });

  it('has a pin like the other tools instead of an On/Off label', async () => {
    renderMenu();
    await userEvent.click(screen.getByLabelText('Tools Options'));
    const item = await screen.findByTestId('tools-menu-hindsight');

    expect(within(item).getByRole('button', { name: 'Pin' })).toBeInTheDocument();
    expect(item).not.toHaveTextContent('com_ui_off');
    expect(item).not.toHaveTextContent('com_ui_on');
  });

  it('pins and unpins without switching the chat, and remembers the pin', async () => {
    const { unmount } = renderMenu();
    await userEvent.click(screen.getByLabelText('Tools Options'));
    const item = await screen.findByTestId('tools-menu-hindsight');

    await userEvent.click(within(item).getByRole('button', { name: 'Pin' }));

    expect(localStorage.getItem(PIN_KEY)).toBe('true');
    expect(within(item).getByRole('button', { name: 'Unpin' })).toBeInTheDocument();
    expect(mockSetEnabled).not.toHaveBeenCalled();

    unmount();
    renderMenu();
    await userEvent.click(screen.getByLabelText('Tools Options'));
    const reopened = await screen.findByTestId('tools-menu-hindsight');
    await userEvent.click(within(reopened).getByRole('button', { name: 'Unpin' }));

    expect(localStorage.getItem(PIN_KEY)).toBe('false');
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it('has no Hindsight item where the chat cannot use it', () => {
    mockConsent.shown = false;
    localStorage.setItem(PIN_KEY, 'true');
    renderMenu();

    /** With no other tools enabled the menu has nothing to show at all. */
    expect(screen.queryByLabelText('Tools Options')).toBeNull();
    expect(screen.queryByTestId('tools-menu-hindsight')).toBeNull();
  });
});
