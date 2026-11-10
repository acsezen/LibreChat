import { useCallback } from 'react';
import { useAtom } from 'jotai';
import { useRecoilValue } from 'recoil';
import { useToastContext } from '@librechat/client';
import {
  Constants,
  AgentCapabilities,
  isAgentsEndpoint,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import {
  useGetAgentByIdQuery,
  useHindsightConsentQuery,
  useHindsightConsentChanging,
  useHindsightAvailabilityQuery,
  useUpdateHindsightConsentMutation,
} from '~/data-provider';
import { hindsightDraftAtom } from '~/store/hindsight';
import { useGetAgentsConfig, useLocalize } from '~/hooks';
import store from '~/store';

/** The Tool Library entry that makes a saved agent Hindsight-capable. */
const HINDSIGHT_TOOL = 'hindsight';

/** Which composer surface an endpoint is: saved agents, plain model chats, or unsupported. */
export function hindsightKind(endpoint?: string | null): HindsightSurface['kind'] {
  if (!endpoint || isAssistantsEndpoint(endpoint)) {
    return null;
  }
  return isAgentsEndpoint(endpoint) ? 'agent' : 'model';
}

export interface HindsightSurface {
  conversationId?: string | null;
  /** `model` for plain model chats, `agent` for saved agents, null where unsupported. */
  kind: 'model' | 'agent' | null;
  agentId?: string | null;
  /** Model specs that hide the badge row never show the control. */
  hidden: boolean;
}

/**
 * Per-chat Hindsight state for the composer. Existing chats show only the
 * server-confirmed value; a new chat holds its own in-memory draft until its
 * first message. The server makes the final decision either way.
 */
export default function useHindsightConsent({
  conversationId,
  kind,
  agentId,
  hidden,
}: HindsightSurface) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const isTemporary = useRecoilValue(store.isTemporary);
  const isSubmitting = useRecoilValue(store.anySubmittingSelector);
  const key = conversationId || Constants.NEW_CONVO;
  const isNew = key === Constants.NEW_CONVO;
  const availability = useHindsightAvailabilityQuery();
  const available = availability.data?.available === true;
  const eligible = available && kind != null && !hidden && !isTemporary;
  const agent = useGetAgentByIdQuery(agentId, {
    enabled: eligible && kind === 'agent' && !!agentId,
  });
  const { agentsConfig } = useGetAgentsConfig();
  /** Like a plugin, the agent entry follows the `tools` capability; the server applies the same gate. */
  const toolsEnabled = agentsConfig?.capabilities?.includes(AgentCapabilities.tools) === true;
  const capable =
    kind === 'agent' ? toolsEnabled && agent.data?.tools?.includes(HINDSIGHT_TOOL) === true : true;
  const supported = eligible && capable;
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
