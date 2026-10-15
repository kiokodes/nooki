export interface Profile {
  id: string;
  couple_id: string | null;
  name: string;
  timezone: string;
  last_seen_at: string;
  created_at: string;
}

export interface Couple {
  id: string;
  invite_code: string;
  anniversary_date: string | null;
  created_at: string;
  breakup_requested_by: string | null;
  breakup_requested_at: string | null;
}

/** How often an event comes back. 'none' fires once, on its own date. */
export type RepeatFrequency = 'none' | 'weekly' | 'monthly' | 'yearly';

export const REPEAT_FREQUENCIES: RepeatFrequency[] = ['none', 'weekly', 'monthly', 'yearly'];

export interface CoupleEvent {
  id: string;
  couple_id: string;
  /** Account that added it; null if that account was later deleted. */
  created_by: string | null;
  title: string;
  /** Plain `YYYY-MM-DD` calendar date, no timezone. */
  event_date: string;
  repeat_frequency: RepeatFrequency;
  created_at: string;
  updated_at: string;
}

/**
 * What a message row is for. Only 'text' is produced by the Chat tab today; the Discuss
 * tab will reuse the same log for prompts ('question'), their replies ('answer') and
 * automatic notes ('system').
 */
export type MessageType = 'text' | 'question' | 'answer' | 'system';

export const MESSAGE_TYPES: MessageType[] = ['text', 'question', 'answer', 'system'];

export interface ChatMessage {
  id: string;
  couple_id: string;
  /** Who wrote it; null only for 'system' notes. */
  sender_id: string | null;
  content: string;
  type: MessageType;
  created_at: string;
  /** Set when the *other* partner has seen it — the read receipt. */
  read_at: string | null;
}

/**
 * Where a bubble is in its lifecycle. 'sending' and 'failed' exist only locally while a
 * message is on its way to the database; 'sent' is one check, 'read' is two.
 */
export type MessageDelivery = 'sending' | 'sent' | 'read' | 'failed';

export interface ChatEntry extends ChatMessage {
  delivery: MessageDelivery;
}

export interface UserSession {
  user: {
    id: string;
    email: string;
  };
  profile: Profile | null;
  couple: Couple | null;
  partner: Profile | null;
}
