import { useCallback, useRef, useState } from 'react';
import type { TruthOrDareState } from '../hooks/useTruthOrDare';
import type { TodPrompt, TodPromptType, TodRound, TodSnapshot, TodTheme } from '../lib/truthOrDare';

/**
 * Truth or Dare over in-memory state, for the design preview only.
 *
 * The real room is refereed by Supabase: both partners accept, the server decides whose
 * turn it is, and Realtime nudges the other phone. Here the partner is simulated on a
 * timer — she joins a round a moment after you do — so the picker, the waiting card, the
 * Truth/Dare choice and the pause/end controls can all be looked at without two accounts.
 * Nothing is sent anywhere and no score is kept.
 */

const SAMPLE_TRUTHS = [
  'What is something small I do that makes your day better?',
  'When did you last feel proud of us?',
  'What is one thing you have never told me about your childhood?',
];

const SAMPLE_DARES = [
  'Send me a photo of the view from where you are right now.',
  'Voice-note the last song that made you think of me.',
  'Describe our dream house in thirty seconds, out loud.',
];

const SAMPLE_PROMPTS: Record<TodTheme, { truth: string[]; dare: string[] }> = {
  random: { truth: SAMPLE_TRUTHS, dare: SAMPLE_DARES },
  flirty: {
    truth: ['When did you last want me and say nothing?', 'What is the compliment you wish I said more often?'],
    dare: ['Send me a voice note in your most convincing flirty voice.', 'Text me three things you would do on our next night alone.'],
  },
  spicy: { truth: [], dare: [] },
};

function samplePrompt(theme: TodTheme, type: TodPromptType, round: TodRound): TodPrompt {
  const pool = SAMPLE_PROMPTS[theme][type];
  const text = pool[round.completed_count % pool.length] ?? pool[0] ?? 'A prompt for this round.';
  return {
    id: `${round.id}-${type}-${round.completed_count}`,
    type,
    theme,
    intensity: Math.min(5, 1 + Math.floor(round.completed_count / 2)),
    text,
    tags: ['preview'],
    mode: type === 'truth' ? 'text' : 'solo',
  };
}

export function usePreviewTruthOrDare({ userId, partnerId }: { userId: string; partnerId: string }): TruthOrDareState {
  const [snapshot, setSnapshot] = useState<TodSnapshot>({
    round: null,
    ages: {
      mine: { tier: 20, source: 'confirmation' },
      partner: { tier: 20, source: 'confirmation' },
    },
    active_counts: {
      random: { truth: 120, dare: 120 },
      flirty: { truth: 120, dare: 120 },
      spicy: { truth: 0, dare: 0 },
    },
  });
  const [busy, setBusy] = useState(false);
  const rounds = useRef(0);
  const timers = useRef<number[]>([]);

  const later = useCallback((delay: number, work: () => void) => {
    const timer = window.setTimeout(work, delay);
    timers.current.push(timer);
  }, []);

  const patchRound = useCallback((work: (round: TodRound) => TodRound) => {
    setSnapshot((current) => current.round ? { ...current, round: work(current.round) } : current);
  }, []);

  const asBusy = useCallback(async (work: () => void) => {
    setBusy(true);
    work();
    setBusy(false);
  }, []);

  return {
    snapshot,
    loading: false,
    busy,
    error: null,
    refresh: async () => {},
    confirmAge: async (minimumAge) => {
      setSnapshot((current) => ({
        ...current,
        ages: { ...current.ages, mine: { tier: minimumAge === 18 ? 18 : 20, source: 'confirmation' } },
      }));
    },
    startRound: async (theme) => asBusy(() => {
      rounds.current += 1;
      const round: TodRound = {
        id: `preview-round-${rounds.current}`,
        couple_id: 'preview-couple',
        theme,
        created_by: userId,
        player_one: userId,
        player_two: partnerId,
        turn_id: userId,
        status: 'inviting',
        accepted_by: [],
        current_prompt: null,
        completed_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setSnapshot((current) => ({ ...current, round }));
    }),
    acceptRound: async () => asBusy(() => {
      setSnapshot((current) => {
        if (!current.round || current.round.accepted_by.includes(userId)) return current;
        return { ...current, round: { ...current.round, accepted_by: [userId] } };
      });
      // The partner joins a beat later, which is when the round opens on both phones.
      later(1400, () => patchRound((round) => round.status === 'inviting'
        ? { ...round, accepted_by: [userId, partnerId], status: 'active', turn_id: userId }
        : round));
    }),
    choosePrompt: async (roundId, type) => asBusy(() => {
      setSnapshot((current) => {
        if (!current.round || current.round.id !== roundId) return current;
        return { ...current, round: { ...current.round, current_prompt: samplePrompt(current.round.theme, type, current.round) } };
      });
    }),
    completePrompt: async (roundId, result) => asBusy(() => {
      setSnapshot((current) => {
        if (!current.round || current.round.id !== roundId) return current;
        // The real room hands the turn to the other phone; the preview keeps it here so
        // the next choice can be tapped straight away.
        return {
          ...current,
          round: {
            ...current.round,
            current_prompt: null,
            completed_count: current.round.completed_count + (result === 'done' ? 1 : 0),
          },
        };
      });
    }),
    pauseRound: async (roundId) => asBusy(() => {
      patchRound((round) => round.id === roundId ? { ...round, status: 'paused' } : round);
    }),
    resumeRound: async (roundId) => asBusy(() => {
      patchRound((round) => round.id === roundId ? { ...round, status: 'active' } : round);
    }),
    endRound: async (roundId) => asBusy(() => {
      setSnapshot((current) => current.round && current.round.id === roundId ? { ...current, round: null } : current);
    }),
  };
}
