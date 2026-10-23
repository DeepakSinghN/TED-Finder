# Talk Finder 2.0: Multi-Channel Talks Database + AI Learning Paths

*Agent build spec. Rebuilds the existing TED Talk Finder into a quota-free, monetizable micro-SaaS.*

---

## 1. Context: Why We Are Rebuilding

The current app (TED Talk Finder) works like this: user searches a topic, Gemini/Grok suggests 12 talks, then the YouTube Data API `search.list` verifies each one against the TED channel.

**Problems with the current design:**

- `search.list` costs **100 units per call**. Free quota is 10,000 units/day, so only about 100 searches per day across *all* users.
- Every user search triggers live YouTube calls, so cost and failure risk scale with traffic.
- The AI can hallucinate talks, which then need verification, which burns more quota.
- Single-channel only (TED), so the content universe is small.
- No reason for users to pay or return (just a search box).

## 2. Product Vision

**Talk Finder 2.0** has two layers:

1. **Layer A: Multi-Channel Talk Database.** We ingest talks from many high-quality YouTube channels (TED, TEDx, Stanford, Google Talks, Y Combinator, etc.) into **our own database**. All user searches hit our DB, never the YouTube API.
2. **Layer B: AI Learning Paths.** The user writes a goal (e.g. "I want to build confidence"). The AI builds an **ordered playlist of 5 to 7 talks** from our DB, each with a key takeaway and one action step.

**Core principle:** YouTube API is used only by a background ingestion job. AI only picks and explains talks that already exist in our DB. No hallucinated talks, no live quota burn.

## 3. Target Users and Value

- Students and professionals who want structured self-improvement through talks.
- People who feel "too many talks, don't know where to start".
- Value: a curated, ordered path with actions, instead of a random list of videos.

## 4. High-Level Architecture

```
[Ingestion Worker (cron)]  -->  [YouTube RSS + playlistItems + videos.list]
        |
        v
[Database: Postgres/SQLite]  <-- talks, channels, embeddings, paths, users
        ^
        |
[API Server (Express/Hono)] <--> [Gemini: embeddings + path generation]
        ^
        |
[Frontend (Astro + Tailwind)]
```

Three independent parts:

1. **Ingestion worker**: fills and refreshes the talk database.
2. **API server**: search, path generation, auth, billing.
3. **Frontend**: search UI, path view, saved paths, pricing.

## 5. Layer A: Multi-Channel Ingestion (Quota-Safe)

### 5.1 Channel list

Maintain a `channels` table seeded with channel IDs. Start with 8 to 12 channels, for example: TED, TEDx Talks, Stanford, Google Talks, Y Combinator, Harvard, Big Think, and Lex Fridman. Verify each channel ID before seeding. Store a `category_hint` (general, startup, science, mental health, etc.).

### 5.2 Initial backfill (one-time, cheap)

For each channel:

1. Derive the **uploads playlist ID**: replace the leading `UC` in the channel ID with `UU`.
2. Call `playlistItems.list` (`part=snippet,contentDetails`, `maxResults=50`, paginate with `pageToken`). **Cost: 1 unit per page of 50.**
3. Collect video IDs, then call `videos.list` (`part=contentDetails,snippet,statistics`, up to **50 IDs per call**). **Cost: 1 unit per call.**
4. Parse ISO-8601 duration to seconds. **Discard videos under 8 minutes** (removes Shorts and teasers; make this threshold configurable per channel).
5. Upsert into `talks`.

A channel with 3,000 videos costs roughly 120 units in total. Backfilling 10 channels stays well within a single day's free quota.

### 5.3 Ongoing refresh (free)

- Every 6 hours, fetch each channel's RSS feed: `https://www.youtube.com/feeds/videos.xml?channel_id=<ID>`. **No quota cost.** (Returns only the latest \~15 videos, which is enough for refresh.)
- For any new video ID not in the DB, fetch details via a batched `videos.list` call.
- Re-sync view counts weekly via batched `videos.list`, optional.

### 5.4 Do NOT use

- `search.list` anywhere in the runtime or ingestion code.
- Any per-video individual API calls (always batch to 50).

### 5.5 Enrichment (per talk, at ingestion time)

- Generate a **short summary (2 to 3 sentences)** and **5 to 8 topic tags** with Gemini (batch several talks per prompt to save cost).
- Generate an **embedding** from `title + speaker + description + summary + tags`.
- Store the results. This is done once per talk, not per user search.
- Optional later: fetch transcripts for better summaries.

## 6. Data Model

**channels**

- `id` (PK, YouTube channel ID), `name`, `uploads_playlist_id`, `category_hint`, `min_duration_sec`, `last_synced_at`, `active`

**talks**

- `video_id` (PK), `channel_id` (FK), `title`, `speaker` (nullable; parse from title or description, e.g. "Title | Speaker"), `description`, `duration_sec`, `thumbnail_url`, `published_at`, `view_count`, `summary`, `tags` (array/JSON), `embedding` (vector), `created_at`, `updated_at`

**users**

- `id`, `email`, `auth_provider`, `plan` (free/pro), `created_at`

**learning\_paths**

- `id`, `user_id` (nullable for anonymous), `goal_text`, `title`, `created_at`, `is_public`, `slug`

**path\_items**

- `id`, `path_id` (FK), `position`, `video_id` (FK), `why_this_talk`, `key_takeaway`, `action_step`

**usage\_log**

- `id`, `user_id` or `ip_hash`, `action` (search/path), `created_at` (for limits)

**Storage choice:**

- MVP: SQLite + FTS5 for keyword search, and embeddings stored as blobs with in-memory cosine similarity (a few thousand talks is fine).
- Scale-up: Postgres (Neon/Supabase) with `pgvector`.

## 7. Search (Layer A, user-facing)

`GET /api/search?q=procrastination`

1. Embed the query with Gemini (cached by normalized query).
2. Run hybrid retrieval: vector similarity top 30 plus keyword match (FTS) boost.
3. Re-rank by `similarity + small recency boost + small popularity boost`.
4. Return the top 12 with the standard card fields: `title, speaker, channelName, duration, thumbnail, videoId, youtubeLink, summary, publishedAt`.

**Zero YouTube API calls.** Cache the final results for 24 hours.

Also keep a **"Recent uploads"** feed: `SELECT ... ORDER BY published_at DESC LIMIT 6`, optionally filtered by channel.

## 8. Layer B: AI Learning Path Generation (Core Paid Feature)

`POST /api/paths` with body `{ "goal": "I want to build confidence before interviews" }`

### Pipeline

1. **Retrieve candidates**: embed the goal, then take the top 25 to 30 talks from the DB.
2. **LLM call (Gemini)**: give it ONLY the candidate list (video\_id, title, speaker, summary, duration, tags) and ask it to:
   - choose **5 to 7 talks** and order them from foundational to advanced/actionable,
   - for each, return `why_this_talk` (1 sentence), `key_takeaway` (1 to 2 sentences), `action_step` (one concrete thing to do this week),
   - return a path `title` and a 1-sentence `overview`.
3. **Strict JSON output** with a fixed schema. Validate with Zod (or similar). Retry once on invalid JSON.
4. **Hard validation**: every returned `video_id` MUST exist in the candidate list. Drop or retry on anything else. This guarantees zero hallucinated talks.
5. Save to `learning_paths` and `path_items`, then return it.

### Rules for the prompt

- Never invent talks, speakers, or facts beyond the provided data.
- Total path length should be under about 2 hours by default (allow the user to choose "short / standard / deep").
- Action steps must be specific and doable (not "reflect on life").
- Respond in the user's language if possible (Hindi/Hinglish goals are common).

### Path features

- Save, rename, and delete paths (logged-in users).
- **Public share link** (`/path/<slug>`) with SEO-friendly page. This is a growth loop.
- Mark talks as watched, with a progress bar.
- Regenerate or swap one talk in a path.

## 9. API Summary

| Method | Endpoint | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/search?q=` | Search the talk DB | optional |
| GET | `/api/recent` | Latest talks feed | none |
| POST | `/api/paths` | Generate a learning path | optional (limits apply) |
| GET | `/api/paths/:id` | Fetch a path | owner or public |
| PATCH | `/api/paths/:id/items/:itemId` | Mark watched / swap talk | owner |
| GET | `/api/me/paths` | List saved paths | required |
| POST | `/api/billing/checkout` | Start Pro subscription | required |
| POST | `/api/billing/webhook` | Payment provider webhook | provider signature |
| POST | `/api/contact` | Keep existing contact form | none |

## 10. Frontend (Astro + Tailwind v4, keep existing design system)

Keep the TED-inspired design language from `Design.md` (black/white, red accent). Pages:

- `/` : hero with two modes, **"Find talks"** (topic search) and **"Build my path"** (goal input). Below: recent uploads.
- `/search?q=` : results grid with channel badges and a channel filter.
- `/path/<slug>` : the learning path view (ordered steps, takeaway, action step, watch buttons, progress).
- `/dashboard` : saved paths, usage, plan.
- `/pricing`, `/login`, plus existing legal pages (`/about`, `/privacy-policy`, `/terms-and-conditions`, `/404`, `/500`).

UI states stay: initial, loading, error, success. Add a path-generation loading state ("Building your path…").

## 11. Monetization

| Plan | Limits | Features |
| --- | --- | --- |
| **Free** | 10 searches/day, 1 path/day, 3 saved paths | Basic paths, public share links |
| **Pro** (about ₹199 to ₹299/month or $4 to $5) | Unlimited searches, unlimited paths | Progress tracking, regenerate/swap talks, "deep" paths, export (PDF/Notion/Markdown), weekly email digest |

Payments: **Razorpay** (India-friendly, UPI) and/or **Stripe**. Enforce limits server-side via `usage_log`.

## 12. Cost Control

- YouTube API: only the ingestion job (about 100 to 300 units/day max). Runtime cost is zero.
- Gemini: embeddings are computed once per talk (ingestion) and once per unique query (cached). Path generation is one LLM call per path with a small candidate list.
- Cache: query embedding cache, search result cache (24h), path generation cache keyed by normalized goal for anonymous users (optional).
- Rate limiting: keep `express-rate-limit` per IP plus plan-based limits per user.
- Multi-key rotation for Gemini can stay, but should rarely be needed now.

## 13. Tech Stack

- **Runtime:** Node.js 22+
- **Backend:** Express (or Hono), TypeScript recommended
- **DB:** SQLite for MVP, Postgres + pgvector for scale
- **AI:** Gemini (embeddings + generation); keep the Grok fallback if desired
- **Frontend:** Astro + Tailwind CSS v4 (reuse existing)
- **Jobs:** `node-cron` or a hosting-platform cron (Cloudflare Cron / Railway / GitHub Actions) for ingestion
- **Auth:** Email magic link or Google login (Auth.js / Lucia / Supabase Auth)
- **Hosting:** Frontend on Cloudflare Pages (existing), backend on Railway/Render/Fly.io

## 14. What to Reuse vs Remove from the Existing Codebase

**Reuse:**

- Astro frontend structure, design system, layout, SEO, legal pages
- ISO-8601 duration parser
- Rate limiting setup, `/api/contact` + Resend
- Mock mode concept (adapt: seed DB with sample talks when no keys are set)

**Remove or replace:**

- Live `search.list` verification flow
- AI-suggests-titles-then-verify pipeline (replace with retrieve-then-rank over our DB)
- YouTube-search-URL fallback with Unsplash thumbnails (no longer needed)
- In-memory-only caching for important data (move persistent data to the DB)

## 15. Build Phases (in order)

**Phase 1: Data foundation**

1. Set up the DB schema and migrations.
2. Build the ingestion script (backfill via playlistItems + batched videos.list, duration filter).
3. Add the RSS refresh job.
4. Seed 8 to 12 channels and verify the data quality.

**Phase 2: Search** 5. Add enrichment (summary, tags, embedding) at ingestion. 6. Build `/api/search` with hybrid retrieval and caching. 7. Connect the existing frontend to the new endpoint and add the channel badge/filter.

**Phase 3: Learning paths** 8. Build `/api/paths` with the retrieve, LLM, validate pipeline. 9. Build the path UI and the public share page.

**Phase 4: Accounts and money** 10. Add auth, saved paths, and progress tracking. 11. Add usage limits and the pricing page. 12. Integrate payments and the webhook.

**Phase 5: Growth** 13. Weekly email digest, SEO landing pages for popular goals, Hindi/Hinglish support.

## 16. Acceptance Criteria (MVP = Phases 1 to 3)

- No runtime code path calls YouTube `search.list`.
- DB contains at least 3,000 talks across at least 8 channels, all above the min duration.
- Search returns relevant results in under 1.5s for cached queries and under 3s uncached.
- A generated path always has 5 to 7 items, and **every video\_id exists in the DB** (validated).
- Invalid LLM output is retried once, then returns a clean error with a retry button.
- Ingestion is idempotent (running it twice creates no duplicates) and logs quota units used.
- App runs locally with one command and works in mock mode without API keys.

## 17. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Poor speaker extraction from titles | Per-channel parsing rules; fall back to the channel name |
| Weak relevance from embeddings alone | Hybrid search (vector + FTS) plus re-ranking |
| LLM returns invalid or invented items | Strict schema, candidate-only prompt, ID validation, retry |
| YouTube ToS concerns | Link out / use the official embed player only; do not download or rehost video; show attribution; keep the disclaimer about TED affiliation |
| Channel catalogs changing | Weekly sync job and an `active` flag on channels |
| Low conversion to Pro | Make shareable paths and progress tracking the hooks; test pricing |

## 18. Notes for the Agent

- Work phase by phase and confirm each phase's acceptance criteria before moving on.
- Prefer simple solutions first (SQLite, in-memory vector search) and keep the data-access layer abstract so Postgres/pgvector can be swapped in later.
- Keep all secrets in `.env`; update `.env.example` with any new variables (`DATABASE_URL`, `GEMINI_API_KEY(S)`, `YOUTUBE_API_KEY(S)`, `RAZORPAY_*` or `STRIPE_*`, `RESEND_API_KEY`).
- Ask the owner before choosing the channel list, pricing, or auth provider if anything is unclear.
