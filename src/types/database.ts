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
  /**
   * The book highlight this message shares ("highlight to chat"): the bubble quotes
   * the passage and tapping it opens the reader at that spot. When the book is
   * deleted the highlight survives with `book_id = null`, so the quote stays on the
   * bubble and only the jump is disabled. NULL for ordinary messages.
   */
  highlight_id: string | null;
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

/* ---------------------------------------------------------------------------
   Shared books: the Media tab's "Read together" shelf. One book in play per
   couple, both partners' places saved in it, and the passages they highlight.
   See supabase/migrations/202610150008_shared_books.sql.
   --------------------------------------------------------------------------- */

export type BookFileType = 'epub' | 'pdf';

export const BOOK_FILE_TYPES: BookFileType[] = ['epub', 'pdf'];

/**
 * The shelf state. 'reading' is the one active book (a partial unique index allows
 * exactly one per couple); 'left' is paused by a partner; 'finished' is done but
 * kept until someone deletes it.
 */
export type BookStatus = 'reading' | 'left' | 'finished';

export const BOOK_STATUSES: BookStatus[] = ['reading', 'left', 'finished'];

export interface SharedBook {
  id: string;
  couple_id: string;
  title: string;
  /** Storage path, always `books/{couple_id}/{id}.{epub|pdf}` in the private bucket. */
  file_path: string;
  file_type: BookFileType;
  status: BookStatus;
  /** Who uploaded it; null if that account was later deleted. */
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Where one partner is in one book. `location` is an EPUB CFI or a PDF page
 * reference — opaque to everything but the reader that wrote it.
 */
export interface ReadingProgress {
  book_id: string;
  user_id: string;
  location: string;
  /** Whole number 0..100, so the card can say "42%". */
  percent: number;
  updated_at: string;
}

/**
 * One fixed colour per person, so a passage reads the same on both phones.
 * The database accepts only these two; the app picks one per partner.
 */
export type HighlightColor = 'rose' | 'sage';

export const HIGHLIGHT_COLORS: HighlightColor[] = ['rose', 'sage'];

export interface Highlight {
  id: string;
  /** NULL only when the book this passage came from has been deleted. */
  book_id: string | null;
  couple_id: string;
  user_id: string;
  /** EPUB: the CFI range of the selection. PDF: a page reference (rects carry the paint). */
  location: string;
  /** PDF rectangles as fractions (0..1) of the page box; null for EPUB highlights. */
  rects: unknown;
  quote_text: string;
  color: HighlightColor;
  created_at: string;
}

/* ---------------------------------------------------------------------------
   "I miss you": the taps one partner leaves behind while the other is away.
   One row per sender per own calendar day, with the total tapped and how many
   of those the partner has already been shown; the difference is what is
   waiting. See supabase/migrations/202610150016_miss_you.sql.
   --------------------------------------------------------------------------- */

/**
 * One day of the batch `public.receive_miss_you_taps` hands back as it marks it received:
 * `newly_delivered` is what was waiting for this reader, `tap_count` the whole day.
 */
export interface MissYouOpenedTap {
  tap_date: string;
  tap_count: number;
  newly_delivered: number;
}

export interface MissYouTap {
  id: string;
  couple_id: string;
  /** Who tapped. The row is that account's own record. */
  sender_id: string;
  /** The sender's own calendar day as `YYYY-MM-DD` — never a UTC guess. */
  tap_date: string;
  /** Every tap of that day, received or not: the "number of taps". */
  tap_count: number;
  /** How many of them the partner has been shown. The reset sets this to `tap_count`. */
  delivered_count: number;
  /** When the partner last opened them; NULL while nothing has been received yet. */
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}
