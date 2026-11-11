import { atom } from 'jotai';
import { createStorageAtom } from './jotai-utils';

/**
 * A new chat's own Hindsight choice before its first message. In memory only:
 * never persisted, and reset on every conversation switch so new chats never
 * inherit it.
 */
export const hindsightDraftAtom = atom(false);

/**
 * The conversation whose rendered Hindsight control currently shows On, if
 * any. Submissions send `hindsightMemory: true` only for that conversation.
 */
export const hindsightAcknowledgedAtom = atom<string | null>(null);

/**
 * Whether the Hindsight badge stays in the composer while Off, set from the
 * Tools menu pin like the other model-chat tools (`LAST_<TOOL>_TOGGLE_pinned`).
 * A display preference only: it never turns Hindsight on for a chat.
 */
export const hindsightPinnedAtom = createStorageAtom<boolean>(
  'LAST_HINDSIGHT_TOGGLE_pinned',
  false,
);
