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

export interface UserSession {
  user: {
    id: string;
    email: string;
  };
  profile: Profile | null;
  couple: Couple | null;
  partner: Profile | null;
}
