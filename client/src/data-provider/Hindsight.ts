import { Constants, MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  THindsightConsent,
  THindsightAvailability,
  THindsightConsentUpdate,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { useStore } from 'jotai';
import { hindsightAcknowledgedAtom } from '~/store/hindsight';

const consentKey = (conversationId: string) => [QueryKeys.hindsightConsent, conversationId];
const consentMutationKey = (conversationId: string) => [
  MutationKeys.updateHindsightConsent,
  conversationId,
];

export function useHindsightAvailabilityQuery() {
  return useQuery<THindsightAvailability>(
    [QueryKeys.hindsightAvailability],
    () => dataService.getHindsightAvailability(),
    { staleTime: Infinity, refetchOnWindowFocus: false },
  );
}

export function useHindsightConsentQuery(conversationId: string, enabled: boolean) {
  return useQuery<THindsightConsent>(
    consentKey(conversationId),
    () => dataService.getHindsightConsent(conversationId),
    { enabled: enabled && conversationId.length > 0, refetchOnWindowFocus: false },
  );
}

/**
 * The displayed state changes only from a server answer. Success cancels any
 * read already in flight (an older answer must not overwrite the confirmed
 * one) before writing it; failure refetches server truth. Both callbacks are
 * awaited by the mutation, so it stays pending until reconciliation is done.
 */
export function useUpdateHindsightConsentMutation(conversationId: string) {
  const queryClient = useQueryClient();
  const queryKey = consentKey(conversationId);
  return useMutation<THindsightConsentUpdate, unknown, boolean>(
    consentMutationKey(conversationId),
    (enabled) => dataService.updateHindsightConsent(conversationId, enabled),
    {
      onSuccess: async (data) => {
        await queryClient.cancelQueries({ queryKey });
        queryClient.setQueryData<THindsightConsent>(queryKey, {
          available: true,
          enabled: data.enabled,
        });
      },
      onError: () => queryClient.invalidateQueries({ queryKey }),
    },
  );
}

/** True while any control's change for this chat is unconfirmed or reconciling. */
export function useHindsightConsentChanging(conversationId: string): boolean {
  return useIsMutating({ mutationKey: consentMutationKey(conversationId) }) > 0;
}

/**
 * The send-time check: a rendered control showed On for this chat, no change
 * from any control is still in flight, and, for an existing chat, the cached
 * state is a successful, current server answer. A failed or invalidated read
 * never counts, even when an older On is still cached. Read synchronously
 * from the stores, so a send cannot slip in before the badge re-renders.
 */
export function isHindsightAcknowledged(
  jotai: ReturnType<typeof useStore>,
  queryClient: QueryClient,
  conversationId: string,
): boolean {
  if (jotai.get(hindsightAcknowledgedAtom) !== conversationId) {
    return false;
  }
  if (queryClient.isMutating({ mutationKey: consentMutationKey(conversationId) }) > 0) {
    return false;
  }
  if (conversationId === Constants.NEW_CONVO) {
    return true;
  }
  const state = queryClient.getQueryState(consentKey(conversationId));
  return state?.status === 'success' && !state.isInvalidated;
}
