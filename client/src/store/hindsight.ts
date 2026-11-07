import { atom } from 'jotai';

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
