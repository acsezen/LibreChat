import { createElement } from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { Constants, dataService } from 'librechat-data-provider';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { HindsightSurface } from '~/hooks/Hindsight/useHindsightConsent';
import { hindsightKind } from '~/hooks/Hindsight/useHindsightConsent';
import { hindsightAcknowledgedAtom, hindsightDraftAtom } from '~/store/hindsight';
import Hindsight from '../Hindsight';
import store from '~/store';

const mockShowToast = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getHindsightConsent: jest.fn(),
      updateHindsightConsent: jest.fn(),
      getHindsightAvailability: jest.fn(),
    },
  };
});

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const api = jest.mocked(dataService);

function setup(
  surface: Partial<HindsightSurface> = {},
  { isSubmitting = false, temporary = false, draft = false } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const jotai = createStore();
  jotai.set(hindsightDraftAtom, draft);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RecoilRoot initializeState={({ set }) => set(store.isTemporary, temporary)}>
      <QueryClientProvider client={queryClient}>
        <Provider store={jotai}>{children}</Provider>
      </QueryClientProvider>
    </RecoilRoot>
  );
  const props: HindsightSurface & { isSubmitting: boolean } = {
    conversationId: 'convo-1',
    kind: 'model',
    hidden: false,
    isSubmitting,
    ...surface,
  };
  const view = render(createElement(Hindsight, props), { wrapper });
  return { ...view, jotai, queryClient };
}

/** Long enough for the availability and consent queries to settle. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

describe('hindsightKind', () => {
  it.each([
    ['openAI', 'model'],
    ['anthropic', 'model'],
    ['agents', null],
    ['assistants', null],
    [null, null],
  ] as const)('gives endpoint %s the %s surface', (endpoint, kind) => {
    expect(hindsightKind(endpoint)).toBe(kind);
  });
});

describe('Hindsight composer switch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    api.getHindsightAvailability.mockResolvedValue({ available: true });
    api.getHindsightConsent.mockResolvedValue({ available: true, enabled: true });
  });

  it('shows a new chat only once its own in-memory draft is On, and switches only that draft', async () => {
    const { jotai } = setup({ conversationId: Constants.NEW_CONVO as string }, { draft: true });
    const toggle = await screen.findByTestId('hindsight-badge');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(jotai.get(hindsightAcknowledgedAtom)).toBe(Constants.NEW_CONVO);

    await userEvent.click(toggle);

    expect(jotai.get(hindsightDraftAtom)).toBe(false);
    expect(screen.queryByTestId('hindsight-badge')).toBeNull();
    expect(jotai.get(hindsightAcknowledgedAtom)).toBeNull();
    expect(api.updateHindsightConsent).not.toHaveBeenCalled();
    expect(api.getHindsightConsent).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('shows the server-confirmed state of an existing chat and confirms it for sending', async () => {
    const { jotai } = setup();
    const toggle = await screen.findByTestId('hindsight-badge');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(api.getHindsightConsent).toHaveBeenCalledWith('convo-1');
    expect(jotai.get(hindsightAcknowledgedAtom)).toBe('convo-1');
  });

  it('changes an existing chat only through the server and follows its answer', async () => {
    api.updateHindsightConsent.mockResolvedValue({ enabled: false });
    const { jotai } = setup();
    const toggle = await screen.findByTestId('hindsight-badge');
    await waitFor(() => expect(toggle).not.toBeDisabled());

    await userEvent.click(toggle);

    expect(api.updateHindsightConsent).toHaveBeenCalledWith('convo-1', false);
    await waitFor(() => expect(screen.queryByTestId('hindsight-badge')).toBeNull());
    expect(jotai.get(hindsightAcknowledgedAtom)).toBeNull();
  });

  it('keeps showing the saved setting and refetches it when a change fails', async () => {
    api.updateHindsightConsent.mockRejectedValue(new Error('409'));
    const { jotai } = setup();
    const toggle = await screen.findByTestId('hindsight-badge');
    await waitFor(() => expect(toggle).not.toBeDisabled());

    await userEvent.click(toggle);

    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    await waitFor(() => expect(api.getHindsightConsent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(jotai.get(hindsightAcknowledgedAtom)).toBe('convo-1');
  });

  it('does not confirm On while a change is still pending', async () => {
    let finish: (value: { enabled: boolean }) => void = () => undefined;
    api.updateHindsightConsent.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const { jotai } = setup();
    const toggle = await screen.findByTestId('hindsight-badge');
    await waitFor(() => expect(jotai.get(hindsightAcknowledgedAtom)).toBe('convo-1'));

    await userEvent.click(toggle);

    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(jotai.get(hindsightAcknowledgedAtom)).toBeNull();
    await act(async () => finish({ enabled: false }));
    await waitFor(() => expect(screen.queryByTestId('hindsight-badge')).toBeNull());
  });

  it('is disabled while a response is generating', async () => {
    setup({}, { isSubmitting: true });
    const toggle = await screen.findByTestId('hindsight-badge');
    await waitFor(() => expect(api.getHindsightConsent).toHaveBeenCalled());
    expect(toggle).toBeDisabled();
  });

  /** Each case has the chat stored On, so only the named condition can hide the switch. */
  it.each([
    [
      'the user is not the Hindsight owner',
      () => api.getHindsightAvailability.mockResolvedValue({ available: false }),
      {},
      {},
    ],
    ['the chat is with a saved agent', () => undefined, { kind: hindsightKind('agents') }, {}],
    ['the model spec hides the badge row', () => undefined, { hidden: true }, {}],
    ['the chat is temporary', () => undefined, {}, { temporary: true }],
    ['the endpoint is unsupported', () => undefined, { kind: null }, {}],
    [
      'the server reports the chat unsupported',
      () => api.getHindsightConsent.mockResolvedValue({ available: false, enabled: true }),
      {},
      {},
    ],
  ] as const)('renders nothing when %s', async (_label, arrange, surface, options) => {
    arrange();
    const { jotai } = setup(surface as Partial<HindsightSurface>, options);
    await waitFor(() => expect(api.getHindsightAvailability).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId('hindsight-badge')).toBeNull();
    expect(jotai.get(hindsightAcknowledgedAtom)).toBeNull();
  });

  it("asks nothing about a saved agent's chat, even one whose switch was stored On", async () => {
    const { jotai } = setup({ kind: hindsightKind('agents') });
    await settle();
    expect(api.getHindsightConsent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hindsight-badge')).toBeNull();
    expect(jotai.get(hindsightAcknowledgedAtom)).toBeNull();
  });

  it.each([
    [true, 1],
    [false, 0],
  ])('in a model chat, shows the switch only while On (stored %s)', async (enabled, count) => {
    api.getHindsightConsent.mockResolvedValue({ available: true, enabled });
    const { jotai } = setup();
    await waitFor(() => expect(api.getHindsightConsent).toHaveBeenCalledWith('convo-1'));
    await settle();
    expect(screen.queryAllByTestId('hindsight-badge')).toHaveLength(count);
    expect(jotai.get(hindsightAcknowledgedAtom)).toBe(enabled ? 'convo-1' : null);
  });

  it('withdraws the confirmation when the switch unmounts', async () => {
    const { jotai, unmount } = setup();
    await waitFor(() => expect(jotai.get(hindsightAcknowledgedAtom)).toBe('convo-1'));
    unmount();
    expect(jotai.get(hindsightAcknowledgedAtom)).toBeNull();
  });
});
