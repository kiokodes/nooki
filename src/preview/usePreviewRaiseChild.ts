import { useCallback, useRef, useState } from 'react';
import type { RaiseChildAlbumEntry, RaiseChildMoment, RaiseChildSnapshot } from '../lib/raiseChildService';
import type { RaiseChildState } from '../hooks/useRaiseChild';

/**
 * Raise a Child over in-memory state, for the design preview only.
 *
 * The real family is refereed by the database: both picks are sealed until the second one
 * lands, and the server decides the outcome. Here the partner answers a moment after you
 * do, so the decision card, the waiting state, the reveal and the album can all be looked
 * at without a backend. Nothing is sent anywhere.
 */

const CATALOG = [
  { slug: 'patient', label: 'Patient', blurb: 'You wait for the second telling.' },
  { slug: 'funny', label: 'Funny', blurb: 'You find the joke in the middle of it.' },
  { slug: 'strict', label: 'Strict', blurb: 'You like the line where you drew it.' },
  { slug: 'adventurous', label: 'Adventurous', blurb: 'You say yes before the plan is finished.' },
  { slug: 'anxious', label: 'Anxious', blurb: 'You think of the thing that could go wrong.' },
  { slug: 'creative', label: 'Creative', blurb: 'You make something out of nothing.' },
  { slug: 'calm', label: 'Calm', blurb: 'Your voice stays low when the room doesn’t.' },
  { slug: 'curious', label: 'Curious', blurb: 'You ask one more question.' },
  { slug: 'warm', label: 'Warm', blurb: 'You make the room easier to be in.' },
  { slug: 'organised', label: 'Organised', blurb: 'You know where the forms are.' },
];

const ALBUM: RaiseChildAlbumEntry[] = [
  {
    id: 'a1', kind: 'milestone', age: 0, title: 'The day Mia arrived',
    body: 'Two parents, three traits each, and a whole childhood ahead. Mia came home today.',
    author_id: null, created_at: new Date(Date.now() - 86_400_000 * 900).toISOString(),
  },
  {
    id: 'a2', kind: 'moment', age: 2, title: 'The wrong shoes',
    body: 'She wore the yellow ones out of the door and regretted it by the corner. You let the walk take longer.',
    author_id: null, created_at: new Date(Date.now() - 86_400_000 * 700).toISOString(),
  },
  {
    id: 'a3', kind: 'gift', age: 3, title: 'Mia said your name',
    body: 'All afternoon, to the fridge, the window, and the cat next door.',
    author_id: null, created_at: new Date(Date.now() - 86_400_000 * 500).toISOString(),
  },
  {
    id: 'a4', kind: 'milestone', age: 4, title: 'First day of school',
    body: 'A bag too big, a uniform too long, and a wave at the gate that lasted a little too long.',
    author_id: null, created_at: new Date(Date.now() - 86_400_000 * 40).toISOString(),
  },
];

const MOMENT_CHOICES = [
  { index: 1, label: 'Clean it up together' },
  { index: 2, label: 'Ask what happened first' },
  { index: 3, label: 'Sit down with her before anything else' },
];

const OUTCOME_TEXT: Record<number, string> = {
  1: 'You swept it up side by side. The vase is gone; the afternoon is not.',
  2: 'She told you the whole story twice. Nobody was cross by the end of it.',
  3: 'You sat on the floor among the pieces until she was ready. The vase was never the point.',
};

function baseSnapshot(): RaiseChildSnapshot {
  const moment: RaiseChildMoment = {
    id: 'm1',
    age: 4,
    category: 'home',
    title: 'The broken vase',
    setup_text: 'A favourite vase is in three pieces on the kitchen floor, and Mia is standing very still beside it.',
    choices: [
      { index: 1, label: 'Clean it up together' },
      { index: 2, label: 'Ask what happened first' },
      { index: 3, label: 'Sit down with her before anything else' },
    ],
    my_choice: null,
    my_revisions: 0,
    partner_voted: false,
    partner_choice: null,
    disagreement: false,
    is_lead: true,
    can_decide: false,
    can_change: false,
    resolved: false,
    outcome: null,
    due_at: new Date(Date.now() + 3_600_000 * 20).toISOString(),
    created_at: new Date().toISOString(),
  };
  return {
    family: { id: 'preview-family', status: 'active', since: new Date(Date.now() - 86_400_000 * 900).toISOString() },
    configured: true,
    config: { moments_per_day: 1, timeout_hours: 24, chapters_per_day: 1, gifts_per_day: 1 },
    setup: {
      name: 'Mia',
      look: { skin: '#E8C4A0', hair: 'curls', outfit: '#F9A8D4' },
      catalog: CATALOG,
      mine: ['patient', 'funny', 'warm'],
      partner_joined: true,
      partner_traits_ready: true,
      ready: true,
      content_ready: true,
      proposal: {
        mine: { name: 'Mia', look: { skin: '#E8C4A0', hair: 'curls', outfit: '#F9A8D4' } },
        partner: { name: 'Mia', look: { skin: '#E8C4A0', hair: 'curls', outfit: '#F9A8D4' } },
        name_same: true,
        look_same: true,
        agreed: true,
        locked: true,
      },
    },
    me: {
      user_id: 'preview-user',
      bond: { band: 'close', line: 'Mia looks for you first when the door opens.' },
      is_lead: true,
    },
    child: {
      name: 'Mia',
      look: { skin: '#E8C4A0', hair: 'curls', outfit: '#F9A8D4' },
      age: 4,
      mood: 'safe',
      traits: [
        { slug: 'kind', label: 'Kind' },
        { slug: 'curious', label: 'Curious' },
        { slug: 'brave', label: 'Brave' },
      ],
      age_label: '4 years old',
    },
    today: {
      moments: [moment],
      gift: {
        id: 'g1',
        title: 'Mia said your name',
        body: 'All afternoon, to the fridge, the window, and the cat next door.',
        day: new Date().toISOString().slice(0, 10),
        opened: false,
      },
      can_age_up: false,
      age_up_hint: 'A moment is still waiting on you both.',
    },
    album: { count: ALBUM.length },
    letter: null,
  };
}

export function usePreviewRaiseChild(): RaiseChildState {
  const [snapshot, setSnapshot] = useState<RaiseChildSnapshot>(baseSnapshot);
  const [busy, setBusy] = useState(false);
  const [album, setAlbum] = useState<RaiseChildAlbumEntry[]>([]);
  const timer = useRef<number | null>(null);

  /** The card settles, both picks on the record, and the year moves on. */
  const settle = useCallback((
    momentId: string,
    chosen: number,
    kind: 'agreement' | 'lead',
  ) => {
    const label = (index: number) => MOMENT_CHOICES.find((choice) => choice.index === index)?.label ?? '';
    setSnapshot((current) => ({
      ...current,
      today: {
        ...current.today,
        moments: current.today.moments.map((entry) => (entry.id === momentId ? {
          ...entry,
          resolved: true,
          partner_voted: true,
          disagreement: false,
          can_decide: false,
          can_change: false,
          outcome: {
            agreement: kind === 'agreement',
            split: kind !== 'agreement',
            timed_out: false,
            decision: kind,
            chosen_index: chosen,
            chosen_label: label(chosen),
            outcome_text: OUTCOME_TEXT[chosen] ?? OUTCOME_TEXT[1],
            note: kind === 'agreement'
              ? 'You both wanted the same thing. Mia felt that.'
              : 'You wanted different things. You had this year’s call, and used it.',
            decided_by: kind === 'agreement' ? null : 'preview-user',
            decided_by_name: kind === 'agreement' ? null : 'you',
          },
        } : entry)),
        can_age_up: true,
        age_up_hint: null,
      },
      child: current.child ? { ...current.child, mood: 'safe' } : current.child,
      album: { count: current.album.count + 1 },
    }));
  }, []);

  /**
   * The first answer, then the partner's (deliberately different) answer, then a possible
   * second answer from you. Two decisions each, exactly as the database allows.
   */
  const vote = useCallback(async (momentId: string, choiceIndex: number) => {
    setBusy(true);
    setSnapshot((current) => {
      const moment = current.today.moments.find((entry) => entry.id === momentId);
      if (!moment) return current;
      const update = (patch: Partial<RaiseChildMoment>) => ({
        ...current,
        today: {
          ...current.today,
          moments: current.today.moments.map((entry) => (entry.id === momentId ? { ...entry, ...patch } : entry)),
        },
      });

      // Already answered, and the partner has too: this is the second say.
      if (moment.my_choice !== null && moment.partner_voted) {
        if (moment.my_revisions >= 1) return current;
        if (moment.partner_choice === choiceIndex) {
          setBusy(false);
          settle(momentId, choiceIndex, 'agreement');
          return update({ my_choice: choiceIndex, my_revisions: 1, disagreement: false, can_change: false, can_decide: false });
        }
        setBusy(false);
        return update({ my_choice: choiceIndex, my_revisions: 1, can_change: false, disagreement: true });
      }

      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        // The partner answers differently, so the split can be looked at in full.
        const theirs = MOMENT_CHOICES.find((choice) => choice.index !== choiceIndex)?.index ?? 1;
        setSnapshot((latest) => ({
          ...latest,
          today: {
            ...latest.today,
            moments: latest.today.moments.map((entry) => (entry.id === momentId ? {
              ...entry,
              partner_voted: true,
              partner_choice: theirs,
              disagreement: true,
              can_decide: entry.is_lead,
              can_change: entry.my_revisions < 1,
            } : entry)),
          },
        }));
        setBusy(false);
      }, 1400);
      return update({ my_choice: choiceIndex });
    });
  }, [settle]);

  const decide = useCallback(async (momentId: string) => {
    setBusy(true);
    setSnapshot((current) => {
      const moment = current.today.moments.find((entry) => entry.id === momentId);
      if (!moment || moment.my_choice === null || !moment.can_decide) return current;
      settle(momentId, moment.my_choice, 'lead');
      return current;
    });
    setBusy(false);
  }, [settle]);

  const ageUp = useCallback(async () => {
    setSnapshot((current) => {
      const nextAge = Math.min(18, (current.child?.age ?? 0) + 1);
      return {
        ...current,
        child: current.child ? { ...current.child, age: nextAge, age_label: `${nextAge} years old`, mood: 'content' } : current.child,
        today: {
          moments: [],
          gift: null,
          can_age_up: false,
          age_up_hint: 'Today’s chapter is done. Come back tomorrow.',
        },
      };
    });
  }, []);

  return {
    snapshot,
    loading: false,
    busy,
    error: null,
    album,
    albumLoading: false,
    clearError: () => {},
    refresh: async () => {},
    saveSetup: async (input) => {
      setSnapshot((current) => ({
        ...current,
        family: current.family && current.family.status !== 'setup' ? current.family : { id: 'preview-family', status: 'active', since: new Date().toISOString() },
        setup: {
      ...current.setup,
      name: input.name ?? current.setup.name,
      mine: input.traits ?? current.setup.mine,
      ready: true,
      proposal: {
        ...current.setup.proposal,
        mine: {
          name: input.name ?? current.setup.proposal.mine?.name ?? 'Mia',
          look: input.look ?? current.setup.proposal.mine?.look ?? current.setup.look,
        },
      },
    },
        child: current.child ?? {
          name: input.name ?? 'Mia',
          look: input.look ?? current.setup.look,
          age: 0,
          mood: 'content',
          traits: [],
          age_label: 'newborn',
        },
      }));
    },
    // The preview never has two parents to agree with; adopting is a no-op that settles.
    adoptSetup: async (part) => {
      setSnapshot((current) => ({
        ...current,
        setup: {
          ...current.setup,
          proposal: part === 'name' || part === 'all'
            ? { ...current.setup.proposal, name_same: true, agreed: true, locked: true }
            : { ...current.setup.proposal, look_same: true, agreed: true, locked: true },
        },
      }));
    },
    vote,
    decide,
    // The real thing posts a linked message; the preview only needs the hand-off to fire.
    toChat: async () => true,
    openGift: async (giftId) => {
      setSnapshot((current) => ({
        ...current,
        today: {
          ...current.today,
          gift: current.today.gift && current.today.gift.id === giftId ? { ...current.today.gift, opened: true } : current.today.gift,
        },
      }));
    },
    ageUp,
    loadAlbum: async () => { setAlbum(ALBUM); },
    reply: async () => {},
    startNewChild: async () => { setSnapshot(baseSnapshot()); setAlbum([]); },
  };
}

/** The letter screen with something in it, for looking at the eight-page letter. */
export function previewLetterState(state: RaiseChildState): RaiseChildState {
  const snapshot = state.snapshot;
  if (!snapshot) return state;
  return {
    ...state,
    snapshot: {
      ...snapshot,
      family: { id: 'preview-family', status: 'letter', since: snapshot.family?.since ?? '' },
      child: snapshot.child ? { ...snapshot.child, age: 18, age_label: 'eighteen', mood: 'tender' } : snapshot.child,
      today: { moments: [], gift: null, can_age_up: false, age_up_hint: null },
      letter: {
        child: 'Mia',
        written_at: new Date().toISOString(),
        paragraphs: [
          'Dear both of you,',
          'I am eighteen today, which is strange to write down. I keep thinking about how many times you must have stood in the kitchen deciding something about me.',
          'You always say I am Kind, Curious, Brave. I think I got that from the two of you, in different measures.',
          'You made 41 decisions about me. 33 of them you saw the same way straight off. The rest you had to talk through, and I noticed that too — how you always came back to the table.',
          'Whatever else was going on, there was always someone at the door when I came home.',
          'Thank you for deciding together, even when it was hard, and for letting me be the reason. I am all right. I am going to be all right.',
        ],
      },
    },
  };
}
