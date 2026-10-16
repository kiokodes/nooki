import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, History, X } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { CategoryPicker } from './CategoryPicker';
import { HistoryList } from './HistoryList';
import { QuestionCard } from './QuestionCard';
import { SessionPanel } from './SessionPanel';
import type { DiscussState, SessionDetail } from '../../hooks/useDiscuss';
import type { Question } from '../../types/database';

interface DiscussViewProps {
  /** App-level Discuss state: the library's shape, this couple's sessions, the 18+ consent. */
  discuss: DiscussState;
  userId: string;
  userName: string;
  partnerName: string;
  /** The 18+ category is turned on from the couple settings sheet. */
  onOpenSettings: () => void;
  /**
   * A question to open because the chat sent us here — the quoted question on a "Say
   * more" bubble. The nonce changes on every tap so the same question can be reopened.
   */
  focusSession: { id: string; nonce: number } | null;
  /** "Say more" under the revealed answers: hand the question to the chat. */
  onSayMore: (detail: SessionDetail) => void;
}

type Screen = 'browse' | 'question' | 'session' | 'history';

interface Filters {
  category: string | null;
  seriousness: number | null;
}

/**
 * The Discuss tab: a question engine over the couple's shared library.
 *
 * Browse a category, choose how heavy it should be, ask your partner, answer privately,
 * and see both answers together once the database says the session is complete. The
 * screens below are navigation over one hook — none of them hold question text of their
 * own, and none of them decide when an answer may be seen.
 */
export const DiscussView: React.FC<DiscussViewProps> = ({
  discuss,
  userId,
  userName,
  partnerName,
  onOpenSettings,
  focusSession,
  onSayMore,
}) => {
  const [screen, setScreen] = useState<Screen>('browse');
  const [draft, setDraft] = useState<{ question: Question; remaining: number } | null>(null);
  const [filters, setFilters] = useState<Filters>({ category: null, seriousness: null });
  /** The category the history list is narrowed to, or null for every question. */
  const [historyCategory, setHistoryCategory] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const openDetail = discuss.sessions.find((entry) => entry.session.id === openSessionId) ?? null;

  // The history filter offers the library's categories, in the order the picker uses.
  const historyCategories = useMemo(
    () => discuss.categories.map((entry) => entry.category),
    [discuss.categories],
  );

  // A tap on a question card in the chat lands here, however deep in a session this
  // screen currently sits. Keyed on the nonce so re-tapping the same quote reopens it;
  // the hook's reloads change `focusSession` by identity, so the ref does the real guard.
  const lastFocusNonce = useRef(0);
  useEffect(() => {
    if (!focusSession || focusSession.nonce === lastFocusNonce.current) return;
    lastFocusNonce.current = focusSession.nonce;
    setNotice(null);
    setDraft(null);
    setOpenSessionId(focusSession.id);
    setScreen('session');
  }, [focusSession]);

  const backToBrowse = () => {
    setScreen('browse');
    setDraft(null);
    setOpenSessionId(null);
  };

  const handlePick = async (category: string | null, seriousness: number | null) => {
    setNotice(null);
    setFilters({ category, seriousness });
    const result = await discuss.pick(category, seriousness);
    if (result.question) {
      setDraft({ question: result.question, remaining: result.remaining });
      setScreen('question');
      return;
    }
    if (result.total === 0) {
      setNotice('Your library has no questions yet. Import your CSV into the Supabase questions table and they appear here.');
      return;
    }
    setNotice(category
      ? `Nothing left in ${category}${seriousness ? ` at level ${seriousness}` : ''}. Try another level, or hit Surprise me.`
      : 'You have asked everything in your library. New questions show up here as soon as they are imported.');
  };

  const handleAsk = async () => {
    if (!draft) return;
    const sessionId = await discuss.ask(draft.question.id);
    if (!sessionId) return;
    setOpenSessionId(sessionId);
    setDraft(null);
    setScreen('session');
  };

  const showMigrationCard = discuss.migrationMissing;
  const showLoading = discuss.loading && !discuss.sessions.length && !showMigrationCard;

  return (
    <section
      data-screen="discuss"
      aria-label="Discuss"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '12px 16px 18px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        /* Scenes come later: this plain sage wash is the backdrop they will sit on. */
        background: `linear-gradient(180deg, ${tokens.colors.accentSageSoft} 0%, ${tokens.colors.bgCanvas} 58%)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800, color: tokens.colors.textPrimary, letterSpacing: '-0.02em' }}>
            Discuss
          </h1>
          <p style={{ margin: '1px 0 0 0', fontSize: '0.74rem', color: tokens.colors.textSecondary }}>
            {discuss.pendingCount > 0
              ? `${discuss.pendingCount} question${discuss.pendingCount === 1 ? '' : 's'} waiting for your answer`
              : 'Private questions, answered together'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Question history"
          onClick={() => setScreen(screen === 'history' ? 'browse' : 'history')}
          style={{
            position: 'relative',
            padding: '9px 14px',
            borderRadius: tokens.radii.pill,
            border: `1.5px solid ${tokens.colors.borderSubtle}`,
            backgroundColor: tokens.colors.bgSurface,
            color: tokens.colors.textSecondary,
            fontSize: '0.78rem',
            fontWeight: 700,
            fontFamily: tokens.typography.fontFamily,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: tokens.shadows.subtle,
          }}
        >
          <History size={14} aria-hidden="true" />
          <span>History</span>
          {discuss.pendingCount > 0 && (
            <span className="nooki-nav-badge" data-discuss-pending aria-hidden="true">
              {discuss.pendingCount > 99 ? '99+' : discuss.pendingCount}
            </span>
          )}
        </button>
      </div>

      {showMigrationCard && (
        <div
          data-discuss-missing
          style={{
            padding: '20px 18px',
            borderRadius: tokens.radii.lg,
            backgroundColor: tokens.colors.bgSurface,
            border: `1.5px solid ${tokens.colors.borderSubtle}`,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            alignItems: 'center',
          }}
        >
          <AlertCircle size={22} color={tokens.colors.textSecondary} aria-hidden="true" />
          <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
            {discuss.error}
          </p>
          <p style={{ margin: 0, fontSize: '0.78rem', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
            The Discuss tab needs the question tables. Run
            {' '}supabase/migrations/202610150004_discuss_questions.sql in the project, then import
            your questions CSV.
          </p>
          <button
            type="button"
            aria-label="Try loading the questions again"
            onClick={() => void discuss.refresh()}
            style={{
              padding: '9px 16px',
              borderRadius: tokens.radii.pill,
              border: 'none',
              backgroundColor: tokens.colors.accentSageDeep,
              color: tokens.colors.textWhite,
              fontSize: '0.8rem',
              fontWeight: 700,
              fontFamily: tokens.typography.fontFamily,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      )}

      {!showMigrationCard && discuss.error && (
        <div
          role="alert"
          data-discuss-error
          style={{
            padding: '11px 14px',
            borderRadius: tokens.radii.md,
            backgroundColor: '#FEF2F2',
            border: '1px solid #FEE2E2',
            color: '#DC2626',
            fontSize: '0.78rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
          }}
        >
          <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
          <span style={{ flex: 1 }}>{discuss.error}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={discuss.clearError}
            style={{ background: 'none', border: 'none', color: '#DC2626', cursor: 'pointer', padding: 0 }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {notice && !showMigrationCard && (
        <p
          data-discuss-notice
          style={{
            margin: 0,
            padding: '10px 14px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.bgSurface,
            border: `1px solid ${tokens.colors.borderSubtle}`,
            color: tokens.colors.textSecondary,
            fontSize: '0.78rem',
            lineHeight: 1.5,
          }}
        >
          {notice}
        </p>
      )}

      {showLoading && (
        <p data-discuss-loading style={{ margin: '24px 0', textAlign: 'center', fontSize: '0.82rem', color: tokens.colors.textSecondary }}>
          Loading your question library…
        </p>
      )}

      {!showMigrationCard && !showLoading && screen === 'browse' && (
        <CategoryPicker
          categories={discuss.categories}
          adultEnabled={discuss.adultEnabled}
          partnerName={partnerName}
          libraryEmpty={discuss.libraryEmpty}
          busy={discuss.busy}
          selectedCategory={filters.category}
          onSelectCategory={(category) => {
            setNotice(null);
            setFilters({ category, seriousness: null });
          }}
          onPick={(category, seriousness) => void handlePick(category, seriousness)}
          onOpenSettings={onOpenSettings}
        />
      )}

      {!showMigrationCard && screen === 'question' && draft && (
        <QuestionCard
          question={draft.question}
          partnerName={partnerName}
          busy={discuss.busy}
          remaining={draft.remaining}
          onAsk={() => void handleAsk()}
          onAnother={() => void handlePick(filters.category, filters.seriousness)}
          onBack={backToBrowse}
        />
      )}

      {!showMigrationCard && screen === 'session' && (
        openDetail ? (
          <SessionPanel
            // Keyed by session: a fresh draft and comment state for every question.
            key={openDetail.session.id}
            detail={openDetail}
            userId={userId}
            userName={userName}
            partnerName={partnerName}
            busy={discuss.busy}
            onBack={backToBrowse}
            onSubmit={(value) => discuss.submit(openDetail.session.id, value)}
            onRevise={discuss.revise}
            onComment={(comment) => discuss.comment(openDetail.session.id, comment)}
            onSayMore={() => onSayMore(openDetail)}
          />
        ) : discuss.loading ? (
          <p data-discuss-loading style={{ margin: '24px 0', textAlign: 'center', fontSize: '0.82rem', color: tokens.colors.textSecondary }}>
            Opening that question…
          </p>
        ) : (
          // A chat quote can point at a session older than the history this phone keeps.
          <div data-session-screen="unavailable" style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'flex-start' }}>
            <p style={{ margin: 0, fontSize: '0.84rem', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
              That question is not in your recent history any more.
            </p>
            <button type="button" aria-label="Back to categories" onClick={backToBrowse} style={{
              padding: '8px 14px',
              borderRadius: tokens.radii.pill,
              border: `1.5px solid ${tokens.colors.borderSoft}`,
              backgroundColor: tokens.colors.bgSurface,
              color: tokens.colors.textSecondary,
              fontSize: '0.8rem',
              fontWeight: 700,
              fontFamily: tokens.typography.fontFamily,
              cursor: 'pointer',
            }}>
              Categories
            </button>
          </div>
        )
      )}

      {!showMigrationCard && screen === 'history' && (
        <HistoryList
          sessions={discuss.sessions}
          categories={historyCategories}
          filter={historyCategory}
          onFilterChange={setHistoryCategory}
          userId={userId}
          partnerName={partnerName}
          onOpen={(sessionId) => {
            setOpenSessionId(sessionId);
            setScreen('session');
          }}
          onBack={backToBrowse}
        />
      )}
    </section>
  );
};

export default DiscussView;
