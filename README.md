# Expense Tracker

Hebrew (RTL), dark, mobile-first app for tracking income and expenses. Plain ES modules (no bundler, no build step) + Supabase for auth (email + password) and storage.

## Features
- Email/password sign-up (with email verification), login, password reset. Multiple users, each sees only their own data (Row Level Security).
- Income vs. expenses over any date range, income types (salary / reserve duty / other + details).
- Recurring monthly items that continue until edited or deleted, investments, custom categories, budgets.
- Charts (donut, monthly bars), reports, chronological transactions page with edit/delete.

## Run locally
ES modules do not load from `file://`, so serve the folder with any static server:

    python -m http.server 5173      # then open http://localhost:5173
    # or: npx serve -l 5173 .

`config.js` already points at the project's Supabase URL and publishable key (both public by design).
To use another Supabase project, copy `config.example.js` to `config.js` and fill it in, then run `supabase/schema.sql` in the SQL Editor.

## Supabase settings checklist
- Authentication -> URL Configuration: set **Site URL** to the app URL and add every URL you use (e.g. `http://localhost:5173`, your GitHub Pages URL) to **Redirect URLs**. Email verification and password-reset links redirect there.
- Authentication -> Providers -> Email: keep "Confirm email" enabled.
- Never put the `service_role` / secret key in this repo.

## Deploy
Static files only: GitHub Pages (Settings -> Pages -> Deploy from branch `main`, root) works as-is.

## Structure
- `index.html`, `src/styles.css` – shell and styles
- `src/main.js` – UI, pages, sheets, business logic
- `src/auth.js` – login / sign-up / reset screens
- `src/data.js` – load from Supabase and diff-based sync of changes
- `src/supabase.js` – client setup (supabase-js from jsDelivr CDN)
- `supabase/schema.sql` – database schema and RLS (already applied to the project)
