# Nooki · Couples App for Long-Distance Partners 🏡💕

**Nooki** is a warm, playful, cozy, and storybook-inspired mobile-first couples app designed for long-distance partners.

---

## 🛠️ Stack

- **Version Control:** GitHub
- **Hosting & CI/CD:** Vercel (SPA routing configured via `vercel.json`)
- **Backend & Database:** Supabase (Auth, PostgreSQL, Row-Level Security, Realtime)
- **Frontend:** React + TypeScript + Vite

---

## 🚀 Supabase Setup

1. Open your project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Go to the **SQL Editor** and run the entire script in:
   ```
   supabase/schema.sql
   ```
   This creates:
   - `profiles` table with row-level security.
   - `couples` table with locked anniversary date.
   - Functions: `join_couple`, `request_or_confirm_breakup`, `cancel_breakup_request`.

---

## 🌐 Vercel Deployment

1. Import your GitHub repository into **Vercel**.
2. In **Project Settings** ➔ **Environment Variables**, add:
   - `VITE_SUPABASE_URL`: Your Supabase Project URL (`https://xyz.supabase.co`)
   - `VITE_SUPABASE_ANON_KEY`: Your Supabase Project Anon Key (`eyJ...`)
3. Deploy! Vercel will automatically build the Vite project using the settings in `vercel.json`.

---

## 🎨 Design Tokens & System

Tokens are centrally defined in `src/tokens/designTokens.ts`:
- **Palette:** Warm cream canvas (`#FAF6EE`), Blush baby pink (`#F9A8D4`), Pastel mint green (`#A7F3D0`), Soft lavender (`#DDD6FE`), and Sage (`#CBD5C0`).
- **Typography:** Friendly rounded typefaces (`Quicksand` / `Nunito`).
- **Cards & Radii:** Large corner radius (`32px`), pill-shaped buttons (`9999px`).
- **Navigation Shell:** 5 tabs (Chat, Media, Home, Discuss, Games), with Home elevated in the center.
- **Lock & Pairing:** The app remains locked until both partners join via the 6-character code.
- **Mutual Breakup:** Dangerous actions require confirmation from both partners.
