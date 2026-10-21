import { useCallback, useMemo, useState } from 'react';
import { EpistleView } from '../components/epistle/EpistleView';
import { toDateKey } from '../lib/calendar';
import type { Epistle } from '../types/database';

/**
 * The epistles on sample data: the real `EpistleView` — mailbox, writing desk, wax
 * seal and reading ceremony — over an in-memory mailbox, so the whole experience can
 * be walked through without a Supabase project or a second phone.
 *
 * The control above the phone seals a letter "from Ana", which is what the other side
 * of the distance would do: the envelope arrives in the mailbox, ready to be opened
 * with the full ceremony.
 */

const NOW = new Date().toISOString();
const TODAY = toDateKey(new Date());
const daysFromToday = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toDateKey(date);
};

const SAMPLE_LETTERS: Epistle[] = [
  {
    id: 'ep-ready',
    couple_id: 'preview-couple',
    sender_id: 'preview-ana',
    title: 'The long way home',
    body: 'My dearest Sam,\n\nIt has been forty-one days, and I have started saying "we" about things that are only mine — the walk home, the rain, the extra spoon of sugar. The distance turns out to be only geography; everything else about you is already here.\n\nCome home soon. I will be the one looking at the door.\n\nAll my love,\nAna',
    sealed_at: NOW,
    opens_at: null,
    opened_at: null,
    reply_to_id: 'ep-keepsake',
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: 'ep-waiting',
    couple_id: 'preview-couple',
    sender_id: 'preview-ana',
    title: 'For our anniversary',
    body: 'If you are reading this, the wax finally let you in. Happy anniversary, my love — press play on our song, and remember that I chose this day on purpose.',
    sealed_at: NOW,
    opens_at: daysFromToday(3),
    opened_at: null,
    reply_to_id: null,
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 86_400_000).toISOString(),
  },
  {
    id: 'ep-keepsake',
    couple_id: 'preview-couple',
    sender_id: 'preview-sam',
    title: 'The first one',
    body: 'Ana — you once said nobody writes letters anymore. Consider this the exception that proves you right.\n\nYours, always,\nSam',
    sealed_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    opens_at: null,
    opened_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    reply_to_id: null,
    created_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
  },
  {
    id: 'ep-reply-keepsake',
    couple_id: 'preview-couple',
    sender_id: 'preview-ana',
    title: 'Re: The first one',
    body: 'Sam —\n\nAn exception that proves me right is still an exception, and I keep rereading it. Consider this the second of many.\n\nYours,\nAna',
    sealed_at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    opens_at: null,
    opened_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    reply_to_id: 'ep-keepsake',
    created_at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  },
];

/** One fresh letter from the other side, sealed this very moment. */
function letterFromAna(n: number): Epistle {
  return {
    id: `ep-ana-${n}`,
    couple_id: 'preview-couple',
    sender_id: 'preview-ana',
    title: 'A little thing I noticed',
    body: 'Sam — today the barista wrote your order on my cup without asking, and I nearly laughed out loud. You are a habit I am grateful for.\n\nAna',
    sealed_at: new Date().toISOString(),
    opens_at: null,
    opened_at: null,
    reply_to_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export const PreviewEpistles = ({ inboxNudge }: { inboxNudge: number }) => {
  // `inboxNudge` is how many letters Ana has sealed since the mailbox was opened;
  // a change to it re-runs the effect that delivers them.
  const [extra, setExtra] = useState<Epistle[]>([]);
  const [delivered, setDelivered] = useState(0);
  const [letters, setLetters] = useState<Epistle[]>(SAMPLE_LETTERS);

  if (inboxNudge > delivered) {
    // One delivery per nudge, newest first — the way Realtime would arrive.
    const arriving = Array.from({ length: inboxNudge - delivered }, (_, index) => letterFromAna(delivered + index + 1));
    setExtra((current) => [...arriving, ...current]);
    setDelivered(inboxNudge);
    setLetters((current) => [...arriving, ...current]);
  }

  // Every action is the database's job in the real app; here it is one list.
  const actions = useMemo(() => ({
    onCreateDraft: async (title: string, body: string, replyToId?: string | null): Promise<Epistle> => {
      const row: Epistle = {
        id: `ep-draft-${Math.random().toString(36).slice(2, 8)}`,
        couple_id: 'preview-couple',
        sender_id: 'preview-sam',
        title: title || null,
        body,
        sealed_at: null,
        opens_at: null,
        opened_at: null,
        reply_to_id: replyToId ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setLetters((current) => [row, ...current]);
      return row;
    },
    onSaveDraft: async (id: string, title: string, body: string, replyToId?: string | null): Promise<Epistle> => {
      const saved: Epistle = {
        ...(letters.find((letter) => letter.id === id) ?? SAMPLE_LETTERS[0]),
        id,
        title: title || null,
        body,
        ...(replyToId !== undefined ? { reply_to_id: replyToId } : {}),
        updated_at: new Date().toISOString(),
      };
      setLetters((current) => current.map((letter) => (letter.id === id ? saved : letter)));
      return saved;
    },
    onSeal: async (id: string, opensAt: string | null): Promise<Epistle> => {
      const sealed: Epistle = {
        ...(letters.find((letter) => letter.id === id) ?? SAMPLE_LETTERS[0]),
        id,
        sealed_at: new Date().toISOString(),
        opens_at: opensAt,
        updated_at: new Date().toISOString(),
      };
      setLetters((current) => current.map((letter) => (letter.id === id ? sealed : letter)));
      return sealed;
    },
    onRecall: async (id: string): Promise<Epistle> => {
      const recalled: Epistle = {
        ...(letters.find((letter) => letter.id === id) ?? SAMPLE_LETTERS[0]),
        id,
        sealed_at: null,
        opens_at: null,
        updated_at: new Date().toISOString(),
      };
      setLetters((current) => current.map((letter) => (letter.id === id ? recalled : letter)));
      return recalled;
    },
    onOpen: async (id: string): Promise<Epistle> => {
      const opened: Epistle = {
        ...(letters.find((letter) => letter.id === id) ?? SAMPLE_LETTERS[0]),
        id,
        opened_at: new Date().toISOString(),
      };
      setLetters((current) => current.map((letter) => (letter.id === id ? opened : letter)));
      return opened;
    },
    onDiscard: async (id: string) => {
      setLetters((current) => current.filter((letter) => letter.id !== id));
    },
  }), [letters]);

  const onClose = useCallback(() => {
    // Leaving the mailbox puts the sample world back the way it was, so the
    // ceremony can be walked again from the top.
    setLetters(SAMPLE_LETTERS);
    setExtra([]);
  }, []);

  void extra;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#f4ecdd' }}>
      <EpistleView
        letters={letters}
        loading={false}
        error={null}
        userId="preview-sam"
        myName="Sam"
        partnerName="Ana"
        myPlace="Lagos, Nigeria"
        todayKey={TODAY}
        onClose={onClose}
        {...actions}
        onClearError={() => {}}
      />
    </div>
  );
};
