# BRL Ops Hub

Internal operations platform for PT Bandang Rezeki Lestari (BRL).
Single-file web app (`index.html`) + Supabase backend, hosted on Netlify.

## Sites
- **Prabumuli** — land clearing (subcontractor model)
- **Maredan** — palm oil replanting (direct operations)

## Deploy
Hosted on Netlify, auto-deploys on every push to `main`.
There is **no build step** — `index.html` is served as-is.

## Editing
1. Edit `index.html`
2. Commit + push (GitHub Desktop: "Commit to main" → "Push origin")
3. Netlify rebuilds automatically (~30 sec)

## Security notes
- The Supabase **anon key** is in `index.html` — this is safe (public by design); Row-Level Security protects the data.
- The **service-role key** and **Anthropic API key** live ONLY in Supabase Edge Function env vars — never in this repo.
- Keep this repository **private**.

## Database (Supabase project `qpaouhptaeldqthxabnk`)
Key tables: `time_sheet`, `breakdowns`, `units`, `work_types`, `equipment_rental`,
`lap_bbm`, `app_settings`, `operational_targets`, `actual_pnl`, `profiles`.
