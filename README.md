# Nooki · Couples App for Long-Distance Partners 🏡💕

**Nooki** is a warm, playful, cozy, and storybook-inspired mobile-first couples app designed for long-distance partners.

---

## 🎨 Design System & Philosophy

- **Style:** Warm, cozy, storybook-like, rounded, gentle tactile warmth.
- **Palette:**
  - **Canvas & Background:** Warm Cream (`#FAF6EE`), Desktop wrapper (`#EFE6D8`)
  - **Primary Duo:** Blush Peach (`#FF9E88`) & Pastel Mint Green (`#88C999`)
  - **Storybook Accents:** Soft Lavender (`#C3B1E1`) & Sage (`#A3B899`)
  - **Currency / Sparks:** Honey Gold (`#F6C26A`)
  - **Ink / Typography:** Soft espresso cocoa tones (`#3A2E2B`) instead of harsh black.
- **Typography:** Friendly rounded typefaces (`Nunito` & `Quicksand`).
- **Cards:** Large corner radius (`28px` to `34px`) with soft, multi-layered warm diffused shadows.
- **Buttons:** Pill-shaped (`9999px` radius) with playful bouncy micro-interactions.
- **Theme:** Light mode only for now, centralized in design tokens.

---

## 📚 Central Design Tokens

All tokens are defined in **`src/tokens/designTokens.ts`** and mapped to CSS Custom Properties in **`src/tokens/injectTokens.ts`**.
You can adjust any color, radius, spacing, or shadow in that single file to change the look and feel of the entire application.

```typescript
export const nookiTokens = {
  colors: { ... },
  radii: { ... },
  shadows: { ... },
  spacing: { ... },
  typography: { ... },
  transitions: { ... },
};
```

---

## 🪐 The Nooki Universe Lexicon

- **Brand / App:** **Nooki**
- **The Users:** **Nookies**
- **The Action (Verb):** **To Nook** / **Nooking**
- **The Action (Noun):** **A Nook** / **Nooks** (*"Check your Nooks," "I sent you a Nook"*)
- **The Shared Couple World:** **Our Nook**
- **The Public Web Board:** **The Square** *(or The Public Nook)*
- **Daily Mini-Game / Question:** **The Daily Nook**
- **In-App Currency / Decor Drops:** **Nookies** / **Nook Bits**

---

## 📱 Navigation Shell

1. **Chat (`/chat`):** Nook whisper messaging, heartbeat sync, and special Nook transmissions.
2. **Media (`/media`):** Shared Spotify/audio listening, photo keepsakes scrapbook, and shared bookmark reading.
3. **Home (`/home`):** *Center, elevated & highlighted (opens by default).* Features "Our Nook" living room scene, distance tracker, and "The Daily Nook" question streak.
4. **Discuss (`/discuss`):** "The Square" public board and deep question decks.
5. **Games (`/games`):** Chibi decor drop shop, mini-games, streak perks, and Nookies bits economy.

Designed for **390px mobile screens first**, with an elegant centered device frame on desktop.
