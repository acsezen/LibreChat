/**
 * The real Tools-menu item and composer switch together, on one query client
 * and one Jotai store, through the real consent hook and data-provider hooks.
 * Only the HTTP layer (`dataService`), the menu popup primitive and unrelated
 * composer context are stubbed.
 */
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { hindsightAcknowledgedAtom } from '~/store/hindsight';
import { isHindsightAcknowledged } from '~/data-provider';
import ToolsDropdown from '../ToolsDropdown';
import Hindsight from '../Hindsight';
import store from '~/store';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getStartupConfig: jest.fn(async () => ({})),
      getHindsightConsent: jest.fn(),
      updateHindsightConsent: jest.fn(),
      getHindsightAvailability: jest.fn(),
    },
  };
});

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    ...jest.requireActual('@librechat/client'),
    PinIcon: () => null,
    VectorIcon: () => null,
    useToastContext: () => ({ showToast: jest.fn() }),
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

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => ({ conversationId: 'convo-1' }),
}));

const api = jest.mocked(dataService);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const jotai = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RecoilRoot initializeState={({ set }) => set(store.isTemporary, false)}>
      <QueryClientProvider client={queryClient}>
        <Provider store={jotai}>{children}</Provider>
      </QueryClientProvider>
    </RecoilRoot>
  );
  render(
    <>
      <ToolsDropdown />
      <Hindsight conversationId="convo-1" kind="model" hidden={false} isSubmitting={false} />
    </>,
    { wrapper },
  );
  const sendable = () => isHindsightAcknowledged(jotai, queryClient, 'convo-1');
  return { jotai, queryClient, sendable };
}

async function openMenuItem() {
  await userEvent.click(screen.getByLabelText('Tools Options'));
  return screen.findByTestId('tools-menu-hindsight');
}

describe('Hindsight Tools menu and composer switch together', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    api.getHindsightAvailability.mockResolvedValue({ available: true });
    api.getHindsightConsent.mockResolvedValue({ available: true, enabled: true });
  });

  it('withdraws the send confirmation the moment the menu starts switching Off', async () => {
    const put = deferred<{ enabled: boolean }>();
    api.updateHindsightConsent.mockReturnValue(put.promise);
    const { jotai, sendable } = setup();
    const badge = await screen.findByTestId('hindsight-badge');
    await waitFor(() => expect(sendable()).toBe(true));

    await userEvent.click(await openMenuItem());

    /** Synchronous send-time check: no render or effect needed. */
    expect(sendable()).toBe(false);
    await waitFor(() => expect(badge).toHaveAttribute('aria-busy', 'true'));
    expect(badge).toBeDisabled();
    expect(jotai.get(hindsightAcknowledgedAtom)).toBeNull();

    await act(async () => put.resolve({ enabled: false }));
    await waitFor(() => expect(screen.queryByTestId('hindsight-badge')).toBeNull());
    expect(sendable()).toBe(false);
  });

  it('stays unconfirmed after a failed change until the server state is read back', async () => {
    api.updateHindsightConsent.mockRejectedValue(new Error('409'));
    const { sendable } = setup();
    await waitFor(() => expect(sendable()).toBe(true));
    const read = deferred<{ available: boolean; enabled: boolean }>();
    api.getHindsightConsent.mockReturnValue(read.promise);

    await userEvent.click(await openMenuItem());

    await waitFor(() => expect(api.getHindsightConsent).toHaveBeenCalledTimes(2));
    expect(sendable()).toBe(false);
    await act(async () => read.resolve({ available: true, enabled: true }));
    await waitFor(() => expect(sendable()).toBe(true));
  });

  it('never confirms a cached On again when the read-back after a failed change also fails', async () => {
    api.updateHindsightConsent.mockRejectedValue(new Error('409'));
    const { jotai, sendable } = setup();
    const badge = await screen.findByTestId('hindsight-badge');
    await waitFor(() => expect(sendable()).toBe(true));
    api.getHindsightConsent.mockRejectedValue(new Error('503'));

    await userEvent.click(await openMenuItem());

    await waitFor(() => expect(api.getHindsightConsent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(badge).toHaveAttribute('aria-checked', 'false'));
    expect(badge).toHaveAttribute('aria-busy', 'true');
    expect(sendable()).toBe(false);
    expect(jotai.get(hindsightAcknowledgedAtom)).toBeNull();

    /** A click now asks the server again; once it answers, On is confirmed again. */
    api.getHindsightConsent.mockResolvedValue({ available: true, enabled: true });
    expect(badge).not.toBeDisabled();
    await userEvent.click(badge);
    await waitFor(() => expect(sendable()).toBe(true));
    expect(api.updateHindsightConsent).toHaveBeenCalledTimes(1);
  });

  it('ignores a second change from the other control while one is pending', async () => {
    const put = deferred<{ enabled: boolean }>();
    api.updateHindsightConsent.mockReturnValue(put.promise);
    setup();
    const badge = await screen.findByTestId('hindsight-badge');
    await waitFor(() => expect(badge).not.toBeDisabled());

    await userEvent.click(await openMenuItem());
    await userEvent.click(screen.getByTestId('tools-menu-hindsight'));

    expect(api.updateHindsightConsent).toHaveBeenCalledTimes(1);
    await act(async () => put.resolve({ enabled: false }));
  });

  it('keeps a confirmed change when an older read finishes after it', async () => {
    const { queryClient } = setup();
    await screen.findByTestId('hindsight-badge');
    const stale = deferred<{ available: boolean; enabled: boolean }>();
    api.getHindsightConsent.mockReturnValue(stale.promise);
    api.updateHindsightConsent.mockResolvedValue({ enabled: false });
    void queryClient.refetchQueries({ queryKey: [QueryKeys.hindsightConsent, 'convo-1'] });
    await waitFor(() => expect(api.getHindsightConsent).toHaveBeenCalledTimes(2));

    await userEvent.click(await openMenuItem());
    await waitFor(() =>
      expect(queryClient.getQueryData([QueryKeys.hindsightConsent, 'convo-1'])).toEqual({
        available: true,
        enabled: false,
      }),
    );
    await act(async () => stale.resolve({ available: true, enabled: true }));

    expect(queryClient.getQueryData([QueryKeys.hindsightConsent, 'convo-1'])).toEqual({
      available: true,
      enabled: false,
    });
  });
});
