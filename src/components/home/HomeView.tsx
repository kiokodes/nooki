import React from 'react';

/**
 * Home tab — the centre tab and the default screen.
 *
 * Deliberately blank for now: the couple names, the together counter, the presence
 * ticker and the partner's local time all live in the global header, so nothing is
 * duplicated here. This empty surface is where the next Home features land.
 */
export const HomeView: React.FC = () => (
  <section data-screen="home" aria-label="Home" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} />
);

export default HomeView;
