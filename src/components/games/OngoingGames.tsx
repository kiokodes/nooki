import { useCallback, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import './games.css';

/** One entry in the "Ongoing games" card: a match this couple can still play. */
export interface OngoingSlide {
  id: string;
  /** The game's name, e.g. "Tetris Duel". */
  name: string;
  /** Whose move the match is waiting on: this phone, or the partner's. */
  waitingOn: 'me' | 'partner';
  /** The line under it: whose move it is, and where the match opens. */
  statusLine: string;
}

/**
 * The couple's live matches, one swipe at a time.
 *
 * Ongoing games used to stack up the page — a couple with four matches open scrolled
 * past four full cards to reach the library. This card holds them at one card's height:
 * the thumb swipes (or the trackpad drags, or the arrows are pressed) from one to the
 * next, so ten ongoing games take the same room as one. Only matches that are still to
 * be played live here; a finished duel is history and is not listed at all — the Games
 * tab holds this card, the game catalogue under it, and the reserved seat above it.
 *
 * A slide waiting on this phone wears a bell, so a thumb walking the card can see at a
 * glance which one wants them, and which is waiting on the partner instead.
 */
export function OngoingGames({ slides, onOpen }: {
  slides: OngoingSlide[];
  onOpen: (id: string) => void;
}) {
  const [active, setActive] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const count = slides.length;
  /** Clamped at read time, so matches leaving the list need no correction afterwards. */
  const activeIndex = Math.min(Math.max(active, 0), Math.max(count - 1, 0));

  /** The dot follows the scroll, so swiping and tapping always agree. */
  const sync = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const width = Math.max(track.clientWidth, 1);
    setActive(Math.min(Math.max(Math.round(track.scrollLeft / width), 0), Math.max(count - 1, 0)));
  }, [count]);

  const goTo = useCallback((index: number) => {
    const track = trackRef.current;
    if (!track) return;
    const target = Math.min(Math.max(index, 0), Math.max(count - 1, 0));
    track.scrollTo({ left: target * track.clientWidth, behavior: 'smooth' });
    setActive(target);
  }, [count]);

  if (!count) return null;

  return (
    <section className="game-card ongoing-games" aria-label="Ongoing games" data-ongoing-games>
      <div className="ongoing-head">
        <h2>Ongoing games</h2>
        <span className="ongoing-count" data-ongoing-count>{count} open</span>
      </div>
      <div
        className="ongoing-track"
        data-ongoing-track
        ref={trackRef}
        tabIndex={0}
        role="group"
        aria-label={`Ongoing games, ${count} open — swipe for more`}
        onScroll={sync}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') { event.preventDefault(); goTo(activeIndex + 1); }
          if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(activeIndex - 1); }
        }}
      >
        {slides.map((slide) => (
          <button
            key={slide.id}
            type="button"
            className={`game-resume ongoing-slide${slide.waitingOn === 'me' ? ' is-my-move' : ''}`}
            data-ongoing-slide={slide.id}
            data-waiting-on={slide.waitingOn}
            onClick={() => onOpen(slide.id)}
          >
            <span className="ongoing-slide-head">
              <strong>{slide.name}</strong>
              {slide.waitingOn === 'me' && (
                <span className="ongoing-bell" data-ongoing-bell aria-label="Waiting for you">
                  <Bell size={13} strokeWidth={2.4} aria-hidden="true" />
                </span>
              )}
            </span>
            <small>{slide.statusLine}</small>
          </button>
        ))}
      </div>
      {count > 1 && (
        <div className="ongoing-dots" data-ongoing-dots>
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              className={index === activeIndex ? 'ongoing-dot is-active' : 'ongoing-dot'}
              aria-label={`Show ${slide.name}`}
              aria-current={index === activeIndex}
              onClick={() => goTo(index)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default OngoingGames;
