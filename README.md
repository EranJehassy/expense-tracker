# Expense Tracker

Hebrew (RTL), dark, mobile-first app for tracking income and expenses. Vite + vanilla JS, Supabase for auth (email + password) and storage.

## Features
- Email/password sign-up (with email verification), login, password reset. Multiple users, each sees only their own data.
- Income vs. expenses over any date range, income types (salary / reserve duty / other + details).
- Recurring monthly items that continue until edited or deleted, investments, custom categories, budgets.
- Charts (donut, monthly bars), reports, chronological transactions page with edit/delete.

## Setup
1. Create a project at https://supabase.com.
2. SQL Editor -> run `supabase/schema.sql` (tables + Row Level Security).
3. Authentication -> URL Configuration: set **Site URL** to the app URL (e.g. `http://localhost:5173` for dev) and add the deployed URL to **Redirect URLs**.
4. Authentication -> Providers -> Email: keep "Confirm email" on.
5. `cp .env.example .env` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Project Settings -> API).
6. `npm install && npm run dev`

## Build
`npm run build` outputs `dist/`. The anon key is public by design; data is protected by the RLS policies in `schema.sql`. Never ship the `service_role` key.

## Structure
- `src/main.js` – UI, pages, sheets, business logic
- `src/auth.js` – login / sign-up / reset screens
- `src/data.js` – load from Supabase and diff-based sync of changes
- `src/supabase.js` – client setup
- `supabase/schema.sql` – database schema and RLS
