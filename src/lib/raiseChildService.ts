import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';

/** Apply before deploying: the family tables, the private-vote policies and the RPCs. */
export const RAISE_CHILD_MIGRATION = 'supabase/migrations/202610300001_raise_a_child.sql';

function isMissingMigration(error: { message: string; code?: string }): boolean {
  return error.code === '42P01'
    || error.code === '42883'
    || error.code === 'PGRST202'
    || (/raise_child|family_moments|event_templates/i.test(error.message)
      && /does not exist|could not find|schema cache/i.test(error.message));
}

function missingMigration(): Error {
  return new Error(`Raising a child needs a database update. Please ask the app owner to apply ${RAISE_CHILD_MIGRATION}.`);
}

// ---------------------------------------------------------------------------------
// Shapes. The database owns every decision; these types only describe what it returns.
// ---------------------------------------------------------------------------------

export type FamilyStatus = 'setup' | 'active' | 'letter' | 'archived';

export interface TraitOption {
  slug: string;
  label: string;
  blurb?: string | null;
}

export interface ChildLook {
  skin?: string;
  hair?: string;
  outfit?: string;
  [key: string]: string | undefined;
}

export interface RaiseChildChoice {
  index: number;
  label: string;
}

export interface MomentOutcome {
  agreement: boolean;
  split: boolean;
  timed_out: boolean;
  chosen_index: number;
  chosen_label: string;
  outcome_text: string;
  note: string;
  decided_by: string | null;
  decided_by_name: string | null;
}

export interface RaiseChildMoment {
  id: string;
  age: number;
  category: string;
  title: string;
  setup_text: string;
  choices: RaiseChildChoice[];
  my_choice: number | null;
  partner_voted: boolean;
  resolved: boolean;
  outcome: MomentOutcome | null;
  due_at: string | null;
  created_at: string;
}

export interface RaiseChildGift {
  id: string;
  title: string;
  body: string;
  day: string;
  opened: boolean;
}

export interface RaiseChildChild {
  name: string;
  look: ChildLook;
  age: number;
  mood: string;
  traits: TraitOption[];
  age_label: string;
}

export interface RaiseChildLetter {
  paragraphs: string[];
  written_at: string;
  child: string;
}

export interface RaiseChildAlbumEntry {
  id: string;
  kind: 'moment' | 'gift' | 'milestone' | 'note' | 'letter';
  age: number;
  title: string;
  body: string;
  author_id: string | null;
  created_at: string;
}

export interface RaiseChildSnapshot {
  family: { id: string; status: FamilyStatus; since: string } | null;
  configured: boolean;
  config: Record<string, number>;
  setup: {
    name: string | null;
    look: ChildLook;
    catalog: TraitOption[];
    mine: string[];
    partner_joined: boolean;
    partner_traits_ready: boolean;
    ready: boolean;
    content_ready: boolean;
  };
  me: { user_id: string | null; bond: { band: string | null; line: string | null } };
  child: RaiseChildChild | null;
  today: {
    moments: RaiseChildMoment[];
    gift: RaiseChildGift | null;
    can_age_up: boolean;
    age_up_hint: string | null;
  };
  album: { count: number };
  letter: RaiseChildLetter | null;
}

// ---------------------------------------------------------------------------------
// Reading the JSON defensively: a malformed card should read as "try again", not crash
// a whole screen.
// ---------------------------------------------------------------------------------

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function toTraits(value: unknown): TraitOption[] {
  return asArray(value).flatMap((entry) => {
    const row = asObject(entry);
    const slug = asString(row.slug);
    if (!slug) return [];
    return [{ slug, label: asString(row.label, slug), blurb: row.blurb == null ? null : asString(row.blurb) }];
  });
}

function toChoices(value: unknown): RaiseChildChoice[] {
  return asArray(value).flatMap((entry) => {
    const row = asObject(entry);
    const index = asNumber(row.index);
    const label = asString(row.label);
    if (index === null || index < 1 || !label) return [];
    return [{ index, label }];
  });
}

function toOutcome(value: unknown): MomentOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const row = asObject(value);
  const chosen = asNumber(row.chosen_index);
  if (chosen === null) return null;
  return {
    agreement: Boolean(row.agreement),
    split: Boolean(row.split),
    timed_out: Boolean(row.timed_out),
    chosen_index: chosen,
    chosen_label: asString(row.chosen_label),
    outcome_text: asString(row.outcome_text),
    note: asString(row.note),
    decided_by: row.decided_by == null ? null : asString(row.decided_by),
    decided_by_name: row.decided_by_name == null ? null : asString(row.decided_by_name),
  };
}

function toMoment(value: unknown): RaiseChildMoment | null {
  const row = asObject(value);
  const id = asString(row.id);
  const title = asString(row.title);
  if (!id || !title) return null;
  const choice = asNumber(row.my_choice);
  return {
    id,
    age: asNumber(row.age) ?? 0,
    category: asString(row.category),
    title,
    setup_text: asString(row.setup_text),
    choices: toChoices(row.choices),
    my_choice: choice !== null && choice >= 1 ? choice : null,
    partner_voted: Boolean(row.partner_voted),
    resolved: Boolean(row.resolved),
    outcome: toOutcome(row.outcome),
    due_at: row.due_at == null ? null : asString(row.due_at),
    created_at: asString(row.created_at),
  };
}

function toGift(value: unknown): RaiseChildGift | null {
  if (!value || typeof value !== 'object') return null;
  const row = asObject(value);
  const id = asString(row.id);
  if (!id) return null;
  return {
    id,
    title: asString(row.title),
    body: asString(row.body),
    day: asString(row.day),
    opened: Boolean(row.opened),
  };
}

function toChild(value: unknown): RaiseChildChild | null {
  if (!value || typeof value !== 'object') return null;
  const row = asObject(value);
  const name = asString(row.name);
  if (!name) return null;
  return {
    name,
    look: asObject(row.look) as ChildLook,
    age: asNumber(row.age) ?? 0,
    mood: asString(row.mood, 'content'),
    traits: toTraits(row.traits),
    age_label: asString(row.age_label, ''),
  };
}

function toLetter(value: unknown): RaiseChildLetter | null {
  if (!value || typeof value !== 'object') return null;
  const row = asObject(value);
  const paragraphs = asArray(row.paragraphs).map((paragraph) => asString(paragraph)).filter(Boolean);
  if (paragraphs.length === 0) return null;
  return { paragraphs, written_at: asString(row.written_at), child: asString(row.child) };
}

export function toSnapshot(value: unknown): RaiseChildSnapshot {
  if (!value || typeof value !== 'object') throw new Error('The family could not be loaded. Please try again.');
  const row = asObject(value);
  const family = row.family && typeof row.family === 'object' ? asObject(row.family) : null;
  const setup = asObject(row.setup);
  const today = asObject(row.today);
  const config = asObject(row.config);
  return {
    family: family && asString(family.id)
      ? { id: asString(family.id), status: asString(family.status, 'setup') as FamilyStatus, since: asString(family.since) }
      : null,
    configured: Boolean(row.configured),
    config: Object.fromEntries(Object.entries(config).map(([key, entry]) => [key, Number(entry) || 0])),
    setup: {
      name: setup.name == null ? null : asString(setup.name),
      look: asObject(setup.look) as ChildLook,
      catalog: toTraits(setup.catalog),
      mine: asArray(setup.mine).map((trait) => asString(trait)).filter(Boolean),
      partner_joined: Boolean(setup.partner_joined),
      partner_traits_ready: Boolean(setup.partner_traits_ready),
      ready: Boolean(setup.ready),
      content_ready: Boolean(setup.content_ready),
    },
    me: {
      user_id: row.me ? (asObject(row.me).user_id == null ? null : asString(asObject(row.me).user_id)) : null,
      bond: (() => {
        const bond = row.me ? asObject(asObject(row.me).bond) : {};
        return {
          band: bond.band == null ? null : asString(bond.band),
          line: bond.line == null ? null : asString(bond.line),
        };
      })(),
    },
    child: toChild(row.child),
    today: {
      moments: asArray(today.moments).map(toMoment).filter((moment): moment is RaiseChildMoment => moment !== null),
      gift: toGift(today.gift),
      can_age_up: Boolean(today.can_age_up),
      age_up_hint: today.age_up_hint == null ? null : asString(today.age_up_hint),
    },
    album: { count: asNumber(asObject(row.album).count) ?? 0 },
    letter: toLetter(row.letter),
  };
}

// ---------------------------------------------------------------------------------
// The eight app-facing calls.
// ---------------------------------------------------------------------------------

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) {
    if (isMissingMigration(error)) throw missingMigration();
    throw new Error(describeDatabaseError(error));
  }
  return data as T;
}

/** The whole family as this parent is allowed to see it. */
export async function fetchRaiseChildState(): Promise<RaiseChildSnapshot> {
  return toSnapshot(await call('raise_child_state'));
}

export interface SetupInput {
  name?: string | null;
  look?: ChildLook;
  traits?: string[];
}

/** Save this parent's three traits and, together, the child's name and look. */
export async function saveRaiseChildSetup({ name, look, traits }: SetupInput): Promise<RaiseChildSnapshot> {
  return toSnapshot(await call('raise_child_setup', {
    p_name: name ?? null,
    p_look: look ?? {},
    p_traits: traits ?? null,
  }));
}

/** Answer today's card privately. The database reveals both answers itself. */
export async function submitRaiseChildVote(momentId: string, choiceIndex: number): Promise<RaiseChildSnapshot> {
  if (!momentId) throw new Error('That moment is no longer open.');
  if (!Number.isInteger(choiceIndex) || choiceIndex < 1 || choiceIndex > 4) {
    throw new Error('Choose one of the options on the card.');
  }
  await call('raise_child_vote', { p_moment_id: momentId, p_choice: choiceIndex });
  return fetchRaiseChildState();
}

export async function openRaiseChildGift(giftId: string): Promise<RaiseChildSnapshot> {
  await call('raise_child_open_gift', { p_gift_id: giftId });
  return fetchRaiseChildState();
}

export async function ageUpRaiseChild(): Promise<RaiseChildSnapshot> {
  return toSnapshot(await call('raise_child_age_up'));
}

export async function fetchRaiseChildAlbum(limit = 40, before: string | null = null): Promise<RaiseChildAlbumEntry[]> {
  const rows = await call<unknown>('raise_child_album', { p_limit: limit, p_before: before });
  return asArray(rows).flatMap((entry) => {
    const row = asObject(entry);
    const id = asString(row.id);
    const kind = asString(row.kind);
    if (!id || !kind) return [];
    return [{
      id,
      kind: kind as RaiseChildAlbumEntry['kind'],
      age: asNumber(row.age) ?? 0,
      title: asString(row.title),
      body: asString(row.body),
      author_id: row.author_id == null ? null : asString(row.author_id),
      created_at: asString(row.created_at),
    }];
  });
}

export async function replyToRaiseChildLetter(note: string): Promise<void> {
  const clean = note.trim();
  if (!clean) throw new Error('Write a line first.');
  if (clean.length > 400) throw new Error('Keep it to 400 characters.');
  await call('raise_child_reply', { p_note: clean });
}

/** Archive the finished family and start again. Nothing in the album is deleted. */
export async function startNewRaiseChild(): Promise<RaiseChildSnapshot> {
  return toSnapshot(await call('raise_child_new_child'));
}

// ---------------------------------------------------------------------------------
// Realtime: both phones see the same reveal without a refresh.
// ---------------------------------------------------------------------------------

export interface RaiseChildSubscriptionHandlers {
  /** A change is only a nudge; the caller re-reads state through the RPC. */
  onChange: () => void;
  onStatus?: (status: string) => void;
}

export interface RaiseChildChannel {
  close: () => void;
}

const REALTIME_TABLES = ['family_moments', 'album_entries', 'family_gifts', 'families', 'child_state'] as const;

/**
 * Live updates for one family. RLS still decides what arrives: a partner's sealed vote is
 * never part of the payload, and the subscription only tells the phone to re-read state.
 */
export function subscribeToRaiseChild(familyId: string, handlers: RaiseChildSubscriptionHandlers): RaiseChildChannel {
  const client = requireSupabase();
  const channel = client.channel(`nooki-raise-child-${familyId}`);
  let current = channel;
  for (const table of REALTIME_TABLES) {
    current = current.on('postgres_changes', {
      schema: 'public',
      table,
      filter: table === 'families' ? `id=eq.${familyId}` : `family_id=eq.${familyId}`,
      event: '*',
    }, handlers.onChange);
  }
  current.subscribe((status: string) => handlers.onStatus?.(status));
  return { close: () => { void client.removeChannel(channel); } };
}
