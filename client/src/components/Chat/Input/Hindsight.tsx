import React, { memo, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { History } from 'lucide-react';
import { composerControlClasses } from '@librechat/client';
import type { HindsightSurface } from '~/hooks/Hindsight/useHindsightConsent';
import useHindsightConsent from '~/hooks/Hindsight/useHindsightConsent';
import { hindsightAcknowledgedAtom } from '~/store/hindsight';
import { badgeAccents } from './accents';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface HindsightProps extends HindsightSurface {
  isSubmitting: boolean;
}

/**
 * A model chat's per-chat Hindsight memory switch: turned on from the Tools
 * menu and shown while On, like LibreChat's other model-chat tool badges.
 * Saved agents have none (their Tool Library entry is always on). A plain
 * switch rather than `CheckboxButton`, whose internal store flips on click
 * before the server confirms the change. Only this rendered control can
 * confirm On for a submission.
 */
function Hindsight({ isSubmitting, ...surface }: HindsightProps) {
  const localize = useLocalize();
  const setAcknowledged = useSetAtom(hindsightAcknowledgedAtom);
  const { key, shown, enabled, pending, unconfirmed, setEnabled } = useHindsightConsent(surface);
  const visible = shown && (enabled || pending);
  const acknowledged = visible && enabled && !pending;

  useEffect(() => {
    setAcknowledged(acknowledged ? key : null);
    return () => setAcknowledged(null);
  }, [acknowledged, key, setAcknowledged]);

  if (!visible) {
    return null;
  }

  const label = localize('com_ui_hindsight');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled && !unconfirmed}
      aria-busy={pending}
      aria-label={label}
      /** Still clickable after a failed read: the click asks the server again. */
      disabled={isSubmitting || (pending && !unconfirmed)}
      data-testid="hindsight-badge"
      onClick={() => setEnabled(!enabled)}
      className={cn(
        composerControlClasses(),
        'w-theme-control max-w-fit p-theme-compact disabled:opacity-60 md:w-full md:px-theme-normal',
        enabled && !unconfirmed && badgeAccents.purple,
      )}
    >
      <span className="icon-md text-text-primary">
        <History className="icon-md" aria-hidden="true" />
      </span>
      <span className="hidden truncate md:block">{label}</span>
    </button>
  );
}

export default memo(Hindsight);
