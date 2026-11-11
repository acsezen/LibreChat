import { useCallback } from 'react';
import { useAtom } from 'jotai';
import { useRecoilValue } from 'recoil';
import { useToastContext } from '@librechat/client';
import { Constants, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import {
  useHindsightConsentQuery,
  useHindsightConsentChanging,
  useHindsightAvailabilityQuery,
  useUpdateHindsightConsentMutation,
} from '~/data-provider';
import { hindsightDraftAtom } from '~/store/hindsight';
import { useLocalize } from '~/hooks';
import store from '~/store';

/**
 * Only plain model chats have the per-chat switch. A saved agent's Hindsight
 * is its Tool Library entry, on in every chat like its other tools, so agent
 * chats (like assistants) have no composer control.
 */
export function hindsightKind(endpoint?: string | null): HindsightSurface['kind'] {
  if (!endpoint || isAssistantsEndpoint(endpoint) || isAgentsEndpoint(endpoint)) {
    return null;
  }
  return 'model';
}

export interface HindsightSurface {
  conversationId?: string | null;
  /** `model` for plain model chats, null where the composer has no switch. */
  kind: 'model' | null;
  /** Model specs that hide the badge row never show the control. */
  hidden: boolean;
}

/**
 * Per-chat Hindsight state for the composer. Existing chats show only the
 * server-confirmed value; a new chat holds its own in-memory draft until its
 * first message. The server makes the final decision either way.
 */
export default function useHindsightConsent({ conversationId, kind, hidden }: HindsightSurface) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const isTemporary = useRecoilValue(store.isTemporary);
  const isSubmitting = useRecoilValue(store.anySubmittingSelector);
  const key = conversationId || Constants.NEW_CONVO;
  const isNew = key === Constants.NEW_CONVO;
  const availability = useHindsightAvailabilityQuery();
  const available = availability.data?.available === true;
  const supported = available && kind != null && !hidden && !isTemporary;
  const consent = useHindsightConsentQuery(key, supported && !isNew);
  const mutation = useUpdateHindsightConsentMutation(key);
  /** Shared by every control: a change started from the Tools menu also holds the badge. */
  const changing = useHindsightConsentChanging(key);
  const [draft, setDraft] = useAtom(hindsightDraftAtom);

  const shown = supported && (isNew || consent.data?.available === true);
  const enabled = isNew ? draft : consent.data?.enabled === true;
  /** A failed read leaves only an older cached answer: never treat it as confirmed. */
  const unconfirmed = !isNew && consent.isError;
  const pending = !isNew && (changing || consent.data == null || unconfirmed);

  const setEnabled = useCallback(
    (value: boolean) => {
      /** The server refuses changes during a run; the controls do not offer one. */
      if (isSubmitting) {
        return;
      }
      /** After a failed read, a click asks the server again instead of changing anything. */
      if (unconfirmed && !changing) {
        void consent.refetch();
        return;
      }
      if (pending) {
        return;
      }
      if (isNew) {
        setDraft(value);
        return;
      }
      mutation.mutate(value, {
        onError: () =>
          showToast({ message: localize('com_ui_hindsight_update_error'), status: 'error' }),
      });
    },
    [
      isNew,
      consent,
      pending,
      changing,
      mutation,
      setDraft,
      localize,
      showToast,
      unconfirmed,
      isSubmitting,
    ],
  );

  return { key, shown, enabled, pending, unconfirmed, isSubmitting, setEnabled };
}
