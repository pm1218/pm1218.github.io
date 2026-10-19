# Kart Club — Mario Kart Wii Grand Prix tracker

A private, mobile-first web app for a small group (< 25 people) to upload, analyse and confirm Mario Kart Wii Grand Prix scores. It lives at **`https://prateekm.me/mariokart/`** (this folder of the `pm1218.github.io` GitHub Pages site) and costs nothing to run.

```
mariokart/
├── index.html, manifest.webmanifest, icon.svg   app shell (installable on a phone home screen)
├── css/app.css                                   mobile-first styles, light + dark
├── js/
│   ├── config.js      Supabase URL + anon key (public by design)
│   ├── app.js         hash router + every view (events, GP entry, stats, profile, admin)
│   ├── api.js         Supabase data layer (auth, tables, RPC, storage, edge function)
│   ├── data.js        points table, characters, cups → tracks
│   ├── scoring.js     internal scoring model, normalisation, 4-race rule (client side)
│   ├── ocr-parse.js   OCR words → result rows (place / name / +gained / points / icon box)
│   ├── vision.js      OpenCV.js + Tesseract.js pipeline, icon template matching
│   ├── identity.js    "which member drove which kart" suggestions
│   ├── analytics.js   power rankings, Elo, consistency, tracks, head-to-head, insights
│   ├── text.js, ui.js helpers
├── supabase/
│   ├── schema.sql                         tables, constraints, RLS, whitelist trigger, submit RPC
│   └── functions/send-gp-summary/index.ts edge function: summary e-mail via Nodemailer
└── tests/            node unit tests, real-Tesseract OCR fixtures, Playwright mobile smoke test
```

---

## 1. Assumptions

1. **Hosting must be GitHub Pages** (your request). Pages serves static files only — no Python/Node server, no database, no server-side sessions — so everything dynamic needs a free hosted backend.
2. **Group size < 25, a few GPs per session.** Data stays tiny (thousands of rows), so analytics are computed in the browser from the full dataset; no caching or background jobs.
3. **Mario Kart Wii rules:** a Grand Prix is exactly 4 races; 12 karts; race points 15-12-10-8-7-6-5-4-3-2-1-0; max GP total 60. Cups map to fixed track orders, so picking the cup pre-fills the 4 tracks.
4. **Karts:** a GP can include members, guests and CPUs. Only members are ranked, but every entered kart counts toward field size. You may enter just the humans; placements still range over 1-12 (e.g. 1st, 5th, 9th) because CPUs finished in between.
5. **Score screens:** the Wii shows a 12-row list — place, character icon, name (Mii name for humans, character name for CPUs), "+gained" after a race, and points. Photos are taken of a TV with a phone (perspective, glare, blur).
6. **Character icons are not shipped.** Nintendo artwork isn't redistributable, so the matcher starts empty and **learns from your own confirmed photos** (each confirmed GP saves its icon crops as labelled templates). Until then, characters come from CPU names and members' favourites, and the uploader picks from a dropdown.
7. **Login:** a 6-digit email code (OTP). Supabase Auth handles code generation, single use and expiry (set to 600 s = 10 min).
8. **Email:** any SMTP account you own (e.g. Gmail with an app password, ~500 mails/day free). Supabase Edge Functions block ports 25/587, so port **465** is used.
9. **Corrections:** confirmed GPs are locked; an admin can reopen one to fix it.
10. **Admin bootstrap:** the first admin is added once by SQL; after that, admins manage the whitelist in the app.

## 2. Architecture decision

**Static SPA on GitHub Pages + Supabase (free tier) + in-browser computer vision.**

| Layer | Choice | Licence / cost |
|---|---|---|
| Hosting | GitHub Pages (your repo) | free |
| UI | Vanilla ES modules, hand-written CSS, hash router — no build step | — |
| Database | Supabase **PostgreSQL** (relational, constraints, RLS, PL/pgSQL) | Postgres licence; Supabase is Apache-2.0, free tier |
| Auth | Supabase Auth email OTP (GoTrue) | MIT, free tier |
| Photos | Supabase Storage, private bucket | free tier (1 GB) |
| OCR | **Tesseract.js** (Tesseract 5 compiled to WebAssembly) | Apache-2.0 |
| CV | **OpenCV.js** 4.10 (perspective, row detection, template matching) | Apache-2.0 |
| Email | **Nodemailer** inside a Supabase Edge Function, over your SMTP | MIT |

**Why this is the optimal choice here**

- *It's the only way to honour "deploy on GitHub Pages" with real auth and a relational DB.* A Django/Flask app would need a separate paid-or-sleeping host (Render/Fly free tiers sleep or have been cut back) and Pages would just be a link to it.
- *Zero DevOps.* No server to patch, no container, no cron. Supabase gives Postgres, auth, storage and functions behind one key; the frontend is plain files.
- *Security lives in the database.* Row-Level Security means every request — from any client — is checked against the whitelist in Postgres. Score writes go through one `SECURITY DEFINER` function that enforces the 4-race rule; tables have no direct write policies, so the browser can't bypass it.
- *OCR on the phone is free and private.* Tesseract.js/OpenCV.js run in the browser (WebAssembly), so there's no GPU/CPU bill and analysis takes seconds. Python EasyOCR would need a server with PyTorch (~1 GB RAM) — impossible on Pages and not free elsewhere. Tesseract is the stronger fit anyway: the game's text is a clean, fixed-layout UI font, which is exactly where Tesseract does well once rows are isolated.
- *Maintainable.* ~2.5k lines of readable JS + one SQL file. No framework upgrades, no bundler.

**Free/open-source**: every runtime component is open source; the only accounts are GitHub (have it), Supabase free tier, and an SMTP mailbox. Supabase itself can be self-hosted later with the same code.

**Mobile-friendliness**: mobile-first CSS (single column, 46-54 px tap targets, 16 px inputs so iOS doesn't zoom, bottom tab bar with safe-area padding, sticky confirm button), native `<select>`/numeric keypads, camera-friendly `<input type=file accept=image/*>`, horizontal-scrolling tables with a sticky first column, light/dark themes, reduced-motion support, installable as a home-screen app. The Playwright smoke test runs at 390×844 and fails if any page scrolls sideways.

## 3. System architecture plan

```
 Phone browser (GitHub Pages: /mariokart/)
 ├─ app.js views ── api.js ──► Supabase REST (PostgREST) ─► Postgres + RLS
 │                         ├─► Supabase Auth (email OTP) ─► your SMTP
 │                         ├─► Storage (private bucket: photos, icon templates)
 │                         └─► Edge Function send-gp-summary ─► Nodemailer ─► SMTP
 └─ vision.js (OpenCV.js + Tesseract.js, WebAssembly, on-device)
```

- **Backend**: Postgres schema + PL/pgSQL (`submit_grand_prix`, `reopen_grand_prix`), RLS policies, an `auth.users` trigger enforcing the whitelist, and one Deno edge function for email.
- **Frontend**: hash routes `#/events`, `#/events/:id`, `#/gp/:id` (entry form while draft, results once confirmed), `#/stats[/:eventId]`, `#/me`, `#/admin`. Hash routing works on static hosting and keeps the back button natural.
- **Auth flow**: email → `signInWithOtp` → Postgres trigger rejects unknown emails (no account, no mail) → member receives 6-digit code → `verifyOtp` → Supabase issues a JWT session (short-lived access token + rotating refresh token) → app double-checks the whitelist and signs out anyone removed.
- **Image pipeline**: rectify screen → find rows → OCR each row → parse → crop + match icons → suggest identities → normalise into a draft → uploader reviews/overrides → confirm.
- **Normalisation**: every input path (typed totals, typed placements, photo of final screen, photos of 4 race screens) becomes the same *draft* object; the server recomputes all points from placements and ranks totals itself.
- **Mobile UI**: three-tab entry (Final totals / All 4 races / 📷 Photo), one race visible at a time (R1-R4 segmented control with ✓), drafts autosave to the phone so a reload or app switch loses nothing.

## 4. Database schema

All in [`supabase/schema.sql`](supabase/schema.sql).

| Table | Key fields | Constraints |
|---|---|---|
| `approved_users` | `email` citext **PK**, `is_admin`, `added_by`, `added_at` | email format check; deferred trigger keeps ≥ 1 admin |
| `profiles` | `id` → `auth.users` **PK**, `email` unique, `display_name`, `mii_name`, `favorite_character` | character ∈ 25 MKWii characters; created by trigger on first login |
| `events` | `id`, `name`, `kind` (session/weekend/trip/other), `location`, `starts_on`, `created_by` → profiles | name 1-120 chars |
| `grand_prix` | `id`, `event_id` → events (cascade), `seq`, `cup`, `engine_class`, `entry_mode` (total/races), `status` (draft/confirmed), `confirmed_by/at`, `summary_sent_at` | unique (event_id, seq); `seq` auto-numbered; status ⇔ entry_mode+confirmed_at consistency check |
| `gp_participants` | `id`, `gp_id` → grand_prix, `profile_id` → profiles (null = guest/CPU), `label`, `character`, `is_cpu`, `final_total`, `final_place` | total 0-60; place 1-12; CPU can't be a member; partial unique (gp_id, profile_id) |
| `races` | `id`, `gp_id`, `race_number`, `track` | race_number 1-4; unique (gp_id, race_number) |
| `race_results` | `id`, `race_id`, `participant_id`, `placement`, `points` | placement 1-12; unique (race, participant); unique (race, placement); **check points = mkw_points(placement)** |
| `score_uploads` | `id`, `gp_id`, `uploaded_by`, `source` (manual_total/manual_races/photo_total/photo_races), `image_paths[]`, `ocr_raw` jsonb | audit trail of every confirmation |
| `icon_templates` | `id`, `character`, `image_path` unique, `created_by` | the learned icon library |

Relationships: event 1-N grand_prix 1-N gp_participants; grand_prix 1-N races 1-N race_results N-1 gp_participants. Storage bucket `score-photos` is private (8 MB, jpeg/png/webp).

**RLS**: every table is readable only when `is_approved()` (JWT email ∈ `approved_users`). Writes: admins manage `approved_users`; members update only their own profile; members create events/drafts; creators or admins delete; `gp_participants`, `races`, `race_results`, `score_uploads` have **no** write policies — only `submit_grand_prix` writes them.

## 5. Auth implementation

- **Request code** (`api.requestCode`): `supabase.auth.signInWithOtp({ email })`. The UI always says "if this email is a member, a code is on its way" so the whitelist can't be probed.
- **Whitelist gate** (`enforce_whitelist` trigger, `BEFORE INSERT ON auth.users`): unknown emails raise an exception, so Supabase never creates the user and never sends mail.
- **Code properties**: Supabase generates a 6-digit OTP (template uses `{{ .Token }}`), it is single-use, and expires after **Email OTP Expiration = 600 s**. Supabase also rate-limits requests.
- **Email delivery**: Supabase Auth sends through your **custom SMTP** settings (Gmail/any provider) — standard, open protocol, free.
- **Verify** (`api.verifyCode`): `verifyOtp({ email, token, type: 'email' })` → session JWT stored by supabase-js, auto-refreshed.
- **Session security**: access tokens are short-lived signed JWTs; refresh tokens rotate; all data access is re-authorised by RLS on every request, so removing someone from `approved_users` cuts access immediately even if they still hold a token. On boot the app also signs out sessions whose email is no longer approved.
- **Whitelist management**: Admin tab → add email (optionally admin), toggle admin, remove. The last admin can't be removed (constraint trigger).
- **Secrets**: the anon key in `config.js` is public by design (RLS-guarded). The service-role key and SMTP password live only in Supabase secrets (environment variables of the edge function) — never in the repo.

## 6. Event + score models

Internal draft (`js/scoring.js`), identical for every input path:

```js
{ mode: 'total' | 'races',
  source: 'manual_total' | 'manual_races' | 'photo_total' | 'photo_races',
  participants: [{ key, profile_id, label, character, is_cpu, final_total }],
  races: [{ race_number: 1..4, track, results: { [key]: placement } }],
  image_paths: [], ocr_raw: {...} }
```

Normalisation rules:

- **Final totals** → `final_total` per kart (0-60); ranks computed with standard competition ranking (ties share a place: 1, 1, 3).
- **Per-race** → placements only; points derived from the MKWii table; GP total = sum of 4 races. Client points are never trusted — `submit_grand_prix` recomputes them and a CHECK constraint ties `points` to `placement`.
- **Final-screen photo** → rows' `points` become `final_total`, mode `total`.
- **Race-screen photos** → each row's race placement comes from **"+gained"** when visible (15→1st … 0→12th), which also works if the photo was taken after the game re-sorted rows by total; otherwise from the row position. Rows are matched across the 4 photos by fuzzy name.

**The 4-race rule is enforced three times:**

1. **UI**: race tab shows "*n* of 4 races complete", the confirm button stays disabled, and a one-tap "enter final totals instead" switch is offered; the photo tab won't analyse fewer than 4 race photos and offers the final-screen route.
2. **Client model**: `validateDraft` / `toPayload` / `draftFromScreens` refuse incomplete race sets (`INCOMPLETE_RACES`).
3. **Database**: `submit_grand_prix` raises `individual race mode requires all 4 races (got 3). Upload the final total score instead.`, requires race numbers exactly {1,2,3,4}, every kart exactly once per race, distinct placements — and the tables can't be written any other way.

## 7. Image analysis engine

`js/vision.js` (runs on the phone) + `js/ocr-parse.js` (pure, unit-tested):

1. **Rectify** (OpenCV.js): blur → Canny + Otsu masks → largest convex 4-point contour covering 30-98% of the photo = the TV screen → pad 3% → `warpPerspective`. Both rectified and original are tried; the one yielding more rows wins.
2. **Find rows**: CLAHE → Sobel-x → Otsu → horizontal close/dilate → contours; fragments sharing ≥ 50% vertical overlap merge (the name block and the points block of a row are far apart); keep rows wider than 35% with near-median height; max 12.
3. **OCR each row** (Tesseract.js, PSM 7 single line) on three binarisations — white-glyph HSV mask (S < 70, V > 170), Otsu, inverted gray — keeping the most confident. Isolating rows took a synthetic perspective photo from 2/12 rows read (whole-screen OCR) to **12/12**.
4. **Parse** each row against the layout `[place] [icon] [name] … [+gained] [points]`, with digit repair (`l→1`, `O→0`, `S→5` only on numeric-looking tokens), ordinal stripping, missing-place inference, gained⇄placement cross-checks, descending-totals checks, and a 50% majority rule to classify final vs race screens.
5. **Icons**: the icon box comes from the stray glyph Tesseract reports over the icon (or 1.8× text height left of the name), inset 10%, resized to 48×48, compared to learned templates with **0.6 × `TM_CCOEFF_NORMED` + 0.4 × HSV histogram correlation**; confidence blends best score and margin over the runner-up. CPU rows also get their character from the name ("Mario").
6. **Identity suggestion** (`identity.js`): score = 0.6 × name similarity (Mii name / display name, Levenshtein ≥ 60%) + 0.4 × icon confidence when the character is a member's favourite (divided by how many members share that favourite). Greedy one-to-one assignment ≥ 0.3; unmatched rows whose name is a character name become CPUs. Each kart shows the reason, and the uploader can override any mapping before confirming.

Fallbacks: if OpenCV.js can't load, a single sparse-text OCR pass over a contrast-stretched image is used and icon matching uses plain-JS NCC.

**Example output** (real Tesseract 5 run on `tests/fixtures/race_photo.jpg`, a synthetic, perspective-warped, glared photo):

```json
{ "kind": "race", "issues": [],
  "rows": [
    { "place": 1, "name": "Anya",    "gained": 15, "points": 15, "confidence": 87,
      "iconBox": { "x0": 126, "y0": 8, "x1": 202, "y1": 84 },
      "suggestion": { "profile_id": "u-an", "confidence": 0.6, "reasons": ["name \"Anya\" ≈ Anya (100%)"] } },
    { "place": 2, "name": "Prateek", "gained": 12, "points": 12, "confidence": 95,
      "suggestion": { "profile_id": "u-pm", "reasons": ["name \"Prateek\" ≈ PRATEEK (100%)"] } },
    { "place": 3, "name": "Mario",   "gained": 10, "points": 10, "cpuCharacter": "Mario",
      "suggestion": { "is_cpu": true, "reasons": ["name reads as the character \"Mario\" → CPU"] } },
    { "place": 4, "name": "Dev",     "gained": 8,  "points": 8,
      "suggestion": { "profile_id": "u-dv", "reasons": ["name \"Dev\" ≈ DevK (100%)"] } } ] }
```

## 8. Analytics engine

`js/analytics.js` — pure functions over confirmed GPs; members only, field size includes CPUs/guests.

- **Power ranking (0-100)**: `raw = 0.45·(avg pts/60) + 0.30·avg((field−place)/(field−1)) + 0.15·win rate + 0.10·form`, form = EWMA (α 0.5) of points share; `power = 100·(n·raw + 2·mean_raw)/(n + 2)` — Bayesian shrinkage so one lucky GP doesn't top the table. Shown per event and lifetime.
- **Lifetime Elo**: each GP = all pairwise member duels by total; K = 32 split across opponents; zero-sum, start 1500.
- **Consistency**: GP-total σ, coefficient of variation, volatility (mean |Δ| between consecutive GPs), race-placement σ, and a 0-100 score `100·σ_random/(σ_random+σ)` on field-relative placement where `σ_random = √((n+1)/(12(n−1)))` (100 = same place every race, 50 = as scattered as a random finisher).
- **Tracks**: average placement and points per member per track; best/worst 3 (never overlapping); "track kings".
- **Head-to-head**: GPs together, wins/losses/ties, average margin, race-level wins; full win-% matrix.
- **Extra insights**: clutch (race-4 placement vs races 1-3), comebacks (GP wins after ≥ 4th in race 1), longest GP win streak, best GP, perfect 60s, average total by character.

**Example output** (`tests/sample-data.mjs`: 3 GPs, 4 members):

```
Power   1. Anya 73.5 (avg 48.7 pts, place 1.33, 67% wins)   2. Prateek 71.1   3. Sam 56.4 (1 GP, shrunk)   4. Dev 52.3
Elo     Anya 1527 · Prateek 1508 · Sam 1495 · Dev 1470
Consistency  Anya 50 (σ GP 4.2, CV 0.09, volatility 4) · Prateek 43 · Dev 41 (volatility 14.5)
H2H Prateek vs Anya  1–1, 1 tie, avg margin −1 pt; races 3–5
Prateek ▲ Luigi Circuit (1.0), Mushroom Gorge (1.0), Coconut Mall (1.0)  ▼ DK Summit (5.0), Wario's Gold Mine (4.0), Moo Moo Meadows (3.0)
Insights Anya: clutch −0.5 (finishes strong), 2-GP win streak
```

## 9. Views / API / UI

| Route | View |
|---|---|
| `#/login` | email → 6-digit code (numeric keypad, auto-submit at 6 digits, resend, change email) |
| `#/events` | event list + collapsible "New event" form |
| `#/events/:id` | event power rankings, GP list (Draft/Confirmed), add GP (cup → tracks pre-filled), delete |
| `#/gp/:id` (draft) | entry: tabs *Final totals / All 4 races / 📷 Photo*, kart editor (member/guest/CPU, name, character, photo suggestion + reason), live review table, sticky **Confirm & email everyone** |
| `#/gp/:id` (confirmed) | results with medals, race-by-race grid, tracks, photos, resend summary, admin reopen |
| `#/stats[/:eventId]` | scope picker, power, Elo, consistency, head-to-head picker + matrix, best/worst tracks, per-track table filter, insights |
| `#/me` | display name, Mii name, favourite character, sign out |
| `#/admin` | approve/remove emails, toggle admin |

Server API: PostgREST tables (RLS), `rpc/submit_grand_prix`, `rpc/reopen_grand_prix`, `functions/v1/send-gp-summary`, Storage `score-photos`. It's a SPA rather than HTMX (HTMX needs a server rendering HTML; Pages can't). It degrades gracefully: hash routes keep back/forward working, `<noscript>` explains what's needed, OpenCV.js failure falls back to simpler CV, email failure leaves the GP confirmed with a resend button, and drafts survive reloads.

**Example workflow (phone)**: Events → *Lake house weekend* → **+ Add Grand Prix** (Mushroom Cup) → 📷 Photo → *4 race screens* → snap R1-R4 → **Analyze photos** → karts appear with "📷 read 'Prateek' → Prateek (60%)" → fix any dropdown → **Confirm & email everyone** → GP page; everyone gets the summary.

## 10. Full code implementation

All code is in this folder — no placeholders. The only values you supply are your own Supabase project URL/key in `js/config.js` and SMTP secrets (Deployment).

## 11. Sample data & workflows

- **Event creation**: `{ name: "Lake house weekend", kind: "trip", starts_on: "2026-10-17", location: "Deep Creek" }` → `#/events/<uuid>`.
- **Race-by-race upload** (payload sent to `submit_grand_prix`):

```json
{ "mode": "races", "source": "manual_races",
  "participants": [ {"key":"a","profile_id":"…pm","label":"Prateek","character":"Yoshi"},
                    {"key":"b","profile_id":"…an","label":"Anya","character":"Peach"},
                    {"key":"c","profile_id":null,"label":"Mario","is_cpu":true,"character":"Mario"} ],
  "races": [ {"race_number":1,"track":"Luigi Circuit","results":[{"key":"a","placement":1},{"key":"b","placement":2},{"key":"c","placement":3}]},
             {"race_number":2,"track":"Moo Moo Meadows","results":[{"key":"a","placement":3},{"key":"b","placement":1},{"key":"c","placement":2}]},
             {"race_number":3,"track":"Mushroom Gorge","results":[{"key":"a","placement":2},{"key":"b","placement":1},{"key":"c","placement":5}]},
             {"race_number":4,"track":"Toad's Factory","results":[{"key":"a","placement":1},{"key":"b","placement":4},{"key":"c","placement":2}]} ] }
→ {"mode":"races","totals":{"a":52,"b":50,"c":41}}
```

  Same payload with 3 races → `ERROR: individual race mode requires all 4 races (got 3). Upload the final total score instead.`
- **Final total upload**: `{"mode":"total","participants":[{…"final_total":40},{…"final_total":40},{…"final_total":33}]}` → places 1, 1, 3.
- **Image analysis** and **analytics** examples: sections 7 and 8.
- **Summary email**: subject `🏁 Anya wins GP 2 · Flower Cup — Lake trip`, with highlights ("Anya won by 1 point over Dev", "Anya won 2 of the 4 races"), the standings with every race placement, event standings so far, and buttons to the GP and event pages. Sent BCC so addresses stay private.

## 12. Deployment notes (all free)

1. **Supabase project** — create one at supabase.com (free). SQL editor → run `supabase/schema.sql`, then make yourself admin:
   ```sql
   insert into public.approved_users (email, is_admin) values ('your@email.com', true);
   ```
2. **Auth settings** (Authentication):
   - *Providers → Email*: enabled; **Email OTP Expiration = 600**; leave "Confirm email" on.
   - *Email Templates → Magic Link*: replace the body with a code, e.g. `<h2>Your Kart Club code</h2><p style="font-size:28px;letter-spacing:6px"><b>{{ .Token }}</b></p><p>Expires in 10 minutes. Single use.</p>` (do the same for *Confirm signup*).
   - *SMTP Settings*: enable custom SMTP (e.g. Gmail: host `smtp.gmail.com`, port 465, user = your Gmail, password = a Google **app password**). Supabase's built-in mailer only reaches project team members, so this step is required.
   - *URL Configuration → Site URL*: `https://prateekm.me/mariokart/`.
3. **Edge function** (Supabase CLI, free):
   ```bash
   supabase link --project-ref <ref>
   supabase secrets set SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_USER=you@gmail.com \
     SMTP_PASS='<app password>' MAIL_FROM='Kart Club <you@gmail.com>' APP_URL=https://prateekm.me/mariokart/
   supabase functions deploy send-gp-summary
   ```
   (Run from the `mariokart/` folder so the CLI finds `supabase/functions/`.)
4. **Frontend** — put the project URL and anon key (Project Settings → API) in `js/config.js`, commit, push. GitHub Pages publishes `https://prateekm.me/mariokart/` within a minute.
5. **Add members** in the Admin tab. Everyone sets a Mii name + favourite character on the *Me* tab so photo suggestions work.

**Tests**: `npm test` (Node 20+) runs 14 unit tests including the OCR parser on real Tesseract output; `supabase/schema.sql` was verified against PostgreSQL 16 (whitelist trigger, RLS, 4-race rule, ties, last-admin guard); `tests/browser/smoke.py` drives the whole UI at phone size with Playwright against an in-memory Supabase mock. `tests/fixtures/make_screen.py` + `rows_proto.py` regenerate the synthetic photos and the Python reference of the vision pipeline.

**Limits worth knowing**: free Supabase projects pause after a week of no activity (one click to resume); OCR has been tuned on synthetic screens that mimic the layout — after your first real photos, check the analysis panel (rows are outlined on the image) and the icon matcher improves as confirmed GPs add templates.
