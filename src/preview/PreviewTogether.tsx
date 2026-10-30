import React, { useState } from 'react';
import { TogetherView } from '../components/together/TogetherView';
import { RaiseAChildModal } from '../components/raisechild/RaiseAChildModal';
import { previewLetterState, usePreviewRaiseChild } from './usePreviewRaiseChild';
import type { SomedayItem, Visit } from '../types/database';
import { tokens } from '../tokens/designTokens';

/**
 * The Together tab, with the real cards and the real Raise a Child sheet.
 *
 * The preview's job here is to let the family screen be looked at without a backend: the
 * card sits where the app puts it, the sheet opens exactly as it does, and the partner's
 * answer arrives on a timer so the reveal can be seen.
 */

const SAMPLE_VISIT: Visit = {
  id: 'preview-visit',
  couple_id: 'preview-couple',
  start_date: new Date(Date.now() + 86_400_000 * 26).toISOString().slice(0, 10),
  end_date: new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10),
  location: 'Lagos',
  timezone: 'Africa/Lagos',
  is_tentative: false,
  created_by: 'preview-user',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const SAMPLE_ITEMS: SomedayItem[] = [
  {
    id: 's1', couple_id: 'preview-couple', text: 'Find a bakery we both like',
    details: null, sort_order: 1, visit_date: null, visit_id: null,
    created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as SomedayItem,
  {
    id: 's2', couple_id: 'preview-couple', text: 'Learn to make jollof together',
    details: null, sort_order: 2, visit_date: null, visit_id: null,
    created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as SomedayItem,
];

interface PreviewTogetherProps {
  partnerName: string;
  userName: string;
  /** Where "talk it out" goes: the chat tab, exactly as it does in the app. */
  onOpenChat?: () => void;
}

export const PreviewTogether: React.FC<PreviewTogetherProps> = ({ partnerName, userName, onOpenChat }) => {
  const family = usePreviewRaiseChild();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'family' | 'letter'>('family');
  const state = view === 'letter' ? previewLetterState(family) : family;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: '8px', padding: '10px 18px 0', flexWrap: 'wrap' }}>
        {([
          ['family', 'The family at four'],
          ['letter', 'The letter at eighteen'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            style={{
              padding: '6px 12px',
              borderRadius: tokens.radii.pill,
              border: `1px solid ${view === key ? tokens.colors.primaryPink : tokens.colors.borderSoft}`,
              background: view === key ? tokens.colors.primaryPinkSoft : tokens.colors.bgSurface,
              color: view === key ? tokens.colors.primaryPinkDeep : tokens.colors.textSecondary,
              fontFamily: tokens.typography.fontFamily,
              fontSize: '0.72rem',
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <TogetherView
        visit={SAMPLE_VISIT}
        onPlanVisit={() => {}}
        onViewVisitPlans={() => {}}
        somedayItems={SAMPLE_ITEMS}
        onAddSomedayItem={async () => {}}
        onToggleSomedayItem={async () => {}}
        onDeleteSomedayItem={async () => {}}
        onReorderSomedayItems={async () => {}}
        raiseChild={state}
        onOpenRaiseChild={() => setOpen(true)}
        partnerName={partnerName}
      />
      {open && (
        <RaiseAChildModal
          state={state}
          userName={userName}
          partnerName={partnerName}
          onTakeToChat={async () => { setOpen(false); onOpenChat?.(); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};
