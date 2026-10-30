import React from 'react';
import { ChevronRight, Sprout } from 'lucide-react';
import { ChildAvatar } from './ChildAvatar';
import type { RaiseChildState } from '../../hooks/useRaiseChild';
import './raisechild.css';

interface RaiseAChildCardProps {
  state: RaiseChildState;
  partnerName: string;
  onOpen: () => void;
}

function lineFor(state: RaiseChildState, partnerName: string): string {
  const snapshot = state.snapshot;
  if (state.loading) return 'One small moment…';
  if (!snapshot) return 'A small life, raised together — one year at a time.';
  const { family, child, setup, today } = snapshot;
  if (!family) return 'Name a child, choose what matters, and meet them one year at a time.';
  if (family.status === 'setup') {
    if (!setup.partner_traits_ready) return `Waiting for ${partnerName} to pick three things.`;
    return 'Almost ready — choose a name and a face.';
  }
  if (family.status === 'letter') return `${child?.name ?? 'Your child'} is eighteen. The letter is waiting.`;
  if (!child) return 'A small life, raised together.';
  const waiting = today.moments.filter((moment) => !moment.resolved && moment.my_choice === null).length;
  if (waiting > 0) return `A moment is waiting for you — ${child.name} is ${child.age_label}.`;
  if (today.moments.some((moment) => !moment.resolved && moment.my_choice !== null)) {
    return `You have picked. ${partnerName} has one more to read.`;
  }
  if (today.can_age_up) return `The year is done. ${child.name} is ready for the next one.`;
  return `${child.name} is ${child.age_label}, and the day is quiet.`;
}

/** The one entry point: a card in Together, never a tab of its own. */
export const RaiseAChildCard: React.FC<RaiseAChildCardProps> = ({ state, partnerName, onOpen }) => {
  const child = state.snapshot?.child ?? null;
  const age = child?.age ?? 0;
  return (
    <button type="button" className="raise-child-card" data-card="raise-a-child" onClick={onOpen}>
      <span className="raise-child-card__portrait" aria-hidden="true">
        {child ? (
          <ChildAvatar look={child.look} age={age} size={54} />
        ) : (
          <Sprout size={24} color="#EC4899" />
        )}
      </span>
      <span className="raise-child-card__copy">
        <span className="raise-child-card__eyebrow">Raise a child</span>
        <span className="raise-child-card__title" style={{ display: 'block' }}>
          {child ? `${child.name}, ${child.age_label}` : 'A childhood, together'}
        </span>
        <span className="raise-child-card__line" style={{ display: 'block' }}>{lineFor(state, partnerName)}</span>
      </span>
      <ChevronRight size={18} className="raise-child-card__arrow" aria-hidden="true" />
    </button>
  );
};
