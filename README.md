# Reel Recipes

Turn saved Instagram cooking reels into a searchable recipe library you can
actually cook from.

**Live:** https://reel-recipes.pages.dev — installable as a PWA, works offline.

---

## The problem

Saving a cooking reel on Instagram is easy. Finding it again, and cooking from
it, is not: the recipe is buried in a caption, spoken aloud, or shown on screen
for two seconds. A saved collection of hundreds of reels is write-only.

This turns that collection into a library with real ingredients, real steps,
and a cook mode you can follow with wet hands.

## Constraints

Three constraints shaped every decision:

- **£0/month.** No paid tier, no free trial that converts, nothing that can
  bill on overage. Everything runs on permanently-free tiers with headroom.
- **Solo-maintainable.** One person, spare time. Boring, stable technology over
  clever, fragile technology.
- **Never lose a reel.** A save is durable the moment it is acknowledged —
  before any extraction is attempted.

## Architecture

```
Phone (PWA)                    Cloudflare Worker              External
───────────                    ─────────────────              ────────
paste / share a link
  │
  ├─► IndexedDB (Dexie) ◄── durable write, ~10ms, offline-capable
  │
  └─► /extract ─────────────► fetch reel metadata ──────────► Instagram
                              parse with Workers AI
      /transcribe ──────────► fetch transcript ─────────────► Supadata
                              reconstruct with Workers AI
```

Static frontend on Cloudflare Pages, plain TypeScript with no framework — the
app is a handful of screens, and a framework would be a maintenance liability
rather than a help.

### The extraction cascade

Instagram has no public API for reading arbitrary reels, and browser JS cannot
fetch instagram.com at all. Extraction therefore happens server-side, on
unofficial access that can break overnight. The cascade is built so that it
degrades rather than fails:

| Tier | Source | Notes |
|---|---|---|
| **1a** | Caption → LLM | Handles prose, inline quantities, non-English captions |
| **1b** | Caption → regex | Local fallback when the LLM is unavailable or the daily allowance is spent. Works offline |
| **2** | Spoken audio → transcript → LLM | For reels where the recipe is narrated, not written |
| **3** | Link only | **Always succeeds.** No external dependency |

Each tier is independently toggleable, so a broken one is a config change
rather than a deploy. With every tier disabled the app still works as a link
organiser — that is the floor the whole product stands on.

### Decisions worth explaining

**The row is written before extraction runs.** Extraction takes 10–30 seconds
and can fail; the save takes 10ms and cannot. Getting this order wrong would
break the product's only real promise.

**A link-only save is a valid outcome, not a failure.** It is never shown in
red, never given an error icon, never apologised for. Roughly half of all
saves land here, and treating them as failures would make the library feel
broken.

**Caption parsing rejects invention; transcript parsing permits it.** A caption
is written text, so anything the model adds is fabrication and is filtered out
against the source. A transcript is mis-heard speech, so the model is allowed
to infer — and everything it produces is flagged as an unverified draft with
its own confidence and a list of what it assumed.

**Categories are suggestions, never assignments.** A library that silently
reorganises itself is unsettling, and a wrong auto-tag erodes trust faster than
a missing one.

## Cost

| Component | Free tier | Usage at ~50 saves/month |
|---|---|---|
| Cloudflare Pages | Unlimited requests | — |
| Cloudflare Workers | 100k requests/day | ~150/month |
| Workers AI | 10,000 neurons/day, **hard-stops** | ~4,900/month |
| Supadata (transcripts) | 100/month, **hard-stops** | ~50/month |

Both AI services stop rather than bill when the allowance is spent, so a
surprise invoice is structurally impossible.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 207 tests
npm run build
```

The Worker is separate:

```bash
cd worker
npm install
npx wrangler deploy
npx wrangler secret put TRANSCRIPT_API_KEY   # optional, enables Tier 2
```

Copy `.env.example` to `.env.local` and set `VITE_WORKER_URL` to point the
frontend at your Worker. Leaving it unset is supported: everything lands at
Tier 3 and the app works as a link organiser.

## Testing

Tests cover the parsers, the data layer, and the extraction cascade — the
places with gnarly real-world inputs and silent failure modes. The UI is
deliberately untested: for a spare-time project a UI suite is a liability to
keep alive.

Real Instagram captions are checked in as fixtures. When the parser breaks on
a new format, the fix arrives as a regression test rather than a bug hunt.

## Known limitations

- **Instagram access is unofficial and will break.** The caption route reads
  the OpenGraph metadata Instagram serves to link-preview crawlers. It works
  today; it may not in three months. The tier toggles exist for that day.
- **Transcription quality varies sharply by language.** Clear English narration
  produces excellent results. Code-switched Tamil/Telugu/English is often badly
  mis-transcribed, which is why those recipes are marked as drafts.
- **Rate limiting.** Instagram throttles datacentre IPs quickly. Fine at a few
  saves a day; a bulk import would need deliberate throttling.

## Licence

MIT
