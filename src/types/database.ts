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
  /**
   * The Discuss question this message continues from, set when "Say more" carries a
   * revealed question into the chat. The bubble renders it as a quoted question card
   * and tapping the card reopens the session — the way back to the answers. NULL for
   * ordinary messages.
   */
  session_id: string | null;
  /**
   * The message this one answers, set by swipe-to-reply or the long-press menu. The
   * bubble renders it as a quoted strip and tapping the strip scrolls back to the
   * original. The database only accepts replies inside the same couple, and the id is
   * frozen with the rest of the row. NULL for ordinary messages.
   */
  reply_to_id: string | null;
  created_at: string;
  /** Set when the *other* partner has seen it — the read receipt. */
  read_at: string | null;
  /**
   * Set by the database when the author rewrote the words. The bubble then shows a
   * small "edited" marker next to its time. NULL while the message is unedited.
   */
  edited_at: string | null;
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

/* ---------------------------------------------------------------------------
   Discuss: one shared question library, and each couple's private sessions.
   The library rows are imported by the app owner from a CSV — never bundled
   here. See supabase/migrations/202610150004_discuss_questions.sql.
   --------------------------------------------------------------------------- */

/**
 * How a question wants to be answered. The database canonicalises whatever the CSV said
 * into these five values; `multi_choice` is the tick-several variant of `choice`.
 */
export type QuestionInputType = 'text' | 'choice' | 'multi_choice' | 'ranking' | 'slider';

export const QUESTION_INPUT_TYPES: QuestionInputType[] = ['text', 'choice', 'multi_choice', 'ranking', 'slider'];

export interface Question {
  /** TEXT in the database: the id belongs to the imported CSV, so it may be any shape. */
  id: string;
  text: string;
  /** Canonical spelling, e.g. 'Home Life'. A CSV can add categories of its own. */
  category: string;
  /** 1 is the lightest, 5 the heaviest. */
  seriousness: number;
  input_type: QuestionInputType;
  /** Option labels for choice / multi_choice / ranking; null for text and slider. */
  options: string[] | null;
  /** 18+: invisible to a couple until both partners turn the category on. */
  is_adult: boolean;
}

export interface QuestionSession {
  id: string;
  couple_id: string;
  question_id: string;
  /** Who tapped "Ask my partner"; null if that account was later deleted. */
  started_by: string | null;
  created_at: string;
  /** Trigger-maintained: how many of the two partners have answered (0, 1 or 2). */
  answer_count: number;
  /** Stamped when the second answer lands — the moment both answers become readable. */
  completed_at: string | null;
}

/**
 * A stored answer: free text, one label, several labels, an ordered list of labels, or a
 * number from 1 to 10. The database checks the shape against the question before it lands.
 */
export type AnswerValue = string | string[] | number;

export interface QuestionAnswer {
  id: string;
  session_id: string;
  user_id: string;
  answer: AnswerValue;
  created_at: string;
}

/**
 * What is left after the reveal: one comment per partner per question. A second thought
 * does not get typed here — it moves to the chat through "Say more"
 * (messages.session_id), where the conversation can go on with the answers one tap away.
 */
export interface AnswerComment {
  id: string;
  session_id: string;
  user_id: string;
  comment: string;
  created_at: string;
  updated_at: string;
}

/**
 * One row per partner. The 18+ category opens only when both partners of a couple have
 * `adult_questions_enabled`, and closes again the moment either of them turns it off.
 */
export interface CoupleSettings {
  couple_id: string;
  user_id: string;
  adult_questions_enabled: boolean;
  updated_at: string;
}
