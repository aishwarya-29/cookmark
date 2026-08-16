# Reel Recipes — Product Requirements Document

**Version:** 1.0
**Date:** 16 August 2026
**Author:** Product
**Audience:** Design team (primary), Engineering (secondary)
**Status:** Ready for design

---

## 1. Summary

A personal recipe library that turns saved Instagram reels into structured, searchable recipes.

Today the user saves cooking reels inside Instagram and never finds them again. Instagram's own "Saved" collections are a flat, image-first grid with no text search, no ingredients, and no way to answer "what can I cook tonight with chicken and 20 minutes?" The reels pile up and the recipes are effectively lost.

This product takes a reel link, extracts a real recipe from it — from the caption, or failing that from the spoken audio, translating to English when needed — and files it into a library the user can search, filter, and organise.

**The one rule that governs everything:** the user never loses a reel. Extraction is best-effort and may fail; saving never does.

### Design north star

> Paste a link, get a recipe. When we can't, get the reel back — never a dead end.

### Non-goals for v1

Explicitly out of scope, so design does not solve for these:

- Multi-user accounts, sharing, social features, or public profiles
- TikTok, YouTube, Pinterest, or web-page recipe import
- Grocery delivery or store integrations
- Nutrition analysis or calorie tracking
- Recipe authoring from scratch (the app is for capture, not creation)
- Native iOS/Android apps (see §3 for why, and §12 for the path there)

---

## 2. User & context

**Primary user:** a single person — the product owner. One account, one library. There is no second persona in v1.

This matters for design: no onboarding funnel to optimise, no empty-state upsell, no sharing affordances, no settings sprawl. Design for someone who already knows what the app is and uses it several times a week.

### The three moments

Design should treat these as three genuinely different contexts, not three screens in one flow.

| Moment | Where | Mindset | What matters |
|---|---|---|---|
| **Capture** | In Instagram, on the phone, mid-scroll | Distracted, 3 seconds of attention | Speed. Zero friction. Must not require leaving the feed for long. |
| **Organise** | Sofa, phone or laptop, later | Relaxed, tidying | Bulk actions, editing, fixing bad extractions |
| **Cook** | Kitchen, phone propped up, hands messy/wet | Focused, hands-busy | Legibility at arm's length, no accidental taps, screen stays on |

The cook moment is the one most recipe apps get wrong. It deserves a dedicated mode, not a reading view.

### Primary user stories

- **US-1** — As a user, I paste a reel link and get back a structured recipe with ingredients and steps, so I can cook from it without rewatching the video.
- **US-2** — As a user, when a reel's recipe is in another language, I get it in English, so I can actually use recipes from creators I follow abroad.
- **US-3** — As a user, when the app can't find a recipe, I still get the reel saved in my library, so nothing is ever lost.
- **US-4** — As a user, I search my library by ingredient, cuisine, or time, so I can decide what to cook tonight.
- **US-5** — As a user, I cook from a recipe on my phone in the kitchen without the screen sleeping or my losing my place.
- **US-6** — As a user, I fix a wrong extraction quickly, so the library stays trustworthy.

---

## 3. Platform decision

**v1 is a mobile-first Progressive Web App (PWA).**

Rationale, and the honest trade-off:

| | PWA | Native iOS |
|---|---|---|
| Cost to run | £0 | $99/year developer account |
| Capture flow | Paste a link | Native Share Sheet — one tap from Instagram |
| Distribution | A URL | App Store review |
| Offline | Service worker, good enough | Better |

The PWA wins on the hard constraint (zero cost) and loses on the most important interaction (capture). **Design's job is to close that gap.** See §5.1 — the clipboard-detection pattern is what makes paste-a-link feel nearly as good as a share sheet, and it is the highest-leverage design work in this project.

Installed to the home screen, a PWA is indistinguishable from a native app for this use case. Design should assume standalone display mode (no browser chrome) and design a splash screen and app icon accordingly.

**Android note:** Android PWAs *can* register as a share target via the Web Share Target API. If the user is on Android, the native share flow is available for free. Design the share-target entry point as a progressive enhancement — the paste flow remains the baseline for iOS.

---

## 4. The extraction pipeline

This is the heart of the product. Design needs to understand it because **the user sees this pipeline as it runs**, and each stage has a different failure mode with a different remedy.

### Cascade

```
Reel link
    │
    ├─► Tier 1: CAPTION ─────────► recipe found? ──► DONE (confidence: high)
    │        │ no
    │        ▼
    ├─► Tier 2: AUDIO ───────────► recipe found? ──► DONE (confidence: medium)
    │        │  transcribe        
    │        │  translate → EN    
    │        │ no
    │        ▼
    └─► Tier 3: LINK ONLY ───────► always succeeds ─► SAVED (needs attention)
```

Each tier is independently disableable and independently failure-tolerant. Tier 3 has no external dependency and therefore cannot fail.

### Requirements

**FR-2.1 — Link ingestion.** Accept any Instagram reel or post URL, in any of the forms Instagram produces: `instagram.com/reel/{id}`, `/reels/{id}`, `/p/{id}`, `share/` redirect links, and links with tracking query params (`?igsh=…`). Normalise to a canonical form. Strip tracking parameters before storing.

**FR-2.2 — Duplicate detection.** If the canonical URL already exists in the library, do not create a second entry. Show the existing recipe and confirm to the user that they already have it. This is a *reassuring* message, not an error.

**FR-2.3 — Tier 1: caption extraction.** Fetch the reel's caption and parse it for recipe content: a title, an ingredient list, and method steps. Captions are messy — expect emoji bullets (🔸, •, ▪️), inline quantities, hashtag walls, "recipe below 👇", and creator preamble. The parser must discard promotional noise and hashtag blocks.

A caption qualifies as a recipe only if it yields **at least two ingredients and at least one method step.** A caption with ingredients but no method is a partial result — save it and flag it, do not discard it and do not fall through to audio.

**FR-2.4 — Tier 2: audio extraction.** When Tier 1 fails, extract the reel's audio track, transcribe it to text, and parse the transcript for recipe content.

**FR-2.5 — Translation.** Detect the transcript's language. If it is not English, translate to English before parsing. Store both the detected source language and the English result. Display the source language on the recipe ("Translated from Tamil") — this is a trust signal, not a footnote; the user should know when they are reading a machine translation.

**FR-2.6 — Tier 3: link fallback.** When both tiers fail, save the reel with whatever metadata was retrievable: thumbnail, creator handle, caption text (unparsed), and the link. Mark it `needs_attention`. This tier must never fail — a total network failure still results in a saved row with just the URL.

**FR-2.7 — Graceful degradation (critical).** Each tier is independently toggleable and independently failure-tolerant. If caption fetching breaks, audio still runs. If audio breaks, the caption tier still runs. If both break, every save lands in Tier 3 and the app remains fully usable as a link organiser.

> **Design implication:** the app must be *good*, not just functional, in the degraded state. Sketch the library as if 100% of entries were Tier 3 saves. If that view is depressing or useless, the design is too dependent on extraction succeeding. This is a real scenario — Instagram access can break overnight and stay broken for days.

**FR-2.8 — Confidence and provenance.** Every recipe records how it was obtained: `caption`, `audio`, `audio_translated`, `manual`, or `link_only`. Surface this in the UI. A recipe from a clean caption and one reconstructed from a noisy transcript deserve different levels of user trust, and the interface should communicate that difference without shouting about it.

**FR-2.9 — Re-extraction.** The user can re-run extraction on any saved recipe. Required for: entries saved during an outage, entries saved before a parser improvement, and Tier 3 entries the user wants to retry. Re-extraction must never destroy manual edits without explicit confirmation.

**FR-2.10 — Manual entry and editing.** Every extracted field is editable. The user can also create a recipe entirely by hand, with no reel attached — the "my grandmother's recipe" case. Manual edits are marked as such and are protected from being overwritten by re-extraction.

### Structured recipe schema

The target of extraction. Design should treat every field except `title` and `source_url` as optional and absent-by-default, because real captions frequently omit them.

| Field | Type | Notes |
|---|---|---|
| `title` | string | Required. Falls back to creator handle + date. |
| `source_url` | string | Required. Canonical reel URL. |
| `creator_handle` | string | For attribution — always display it. |
| `thumbnail` | image | Cached locally; see NFR-4.3 on hotlinking. |
| `ingredients[]` | list | `{quantity, unit, item, note}` — all parts optional |
| `steps[]` | list | Ordered strings |
| `servings` | number | Often absent |
| `prep_time`, `cook_time` | duration | Often absent or vague ("until golden") |
| `cuisine` | enum | Auto-suggested, user-editable |
| `meal_type` | enum | Breakfast / lunch / dinner / snack / dessert / drink |
| `tags[]` | list | Free-form, user-controlled |
| `source_language` | string | Set when translated |
| `extraction_method` | enum | Per FR-2.8 |
| `notes` | rich text | User's own notes — see FR-4.6 |
| `status` | enum | `complete` / `partial` / `needs_attention` |

---

## 5. Functional requirements

### 5.1 Capture

**FR-1.1 — Paste to save.** A single, prominent input accepting a pasted URL. This is the app's front door and should be the first thing visible on launch.

**FR-1.2 — Clipboard detection (highest-leverage interaction in the product).** On app focus, if the clipboard contains an Instagram URL not already in the library, offer to save it in one tap.

This is what makes a PWA competitive with a native share sheet. The user's real flow is: see reel → tap Instagram's share → Copy Link → switch to our app. If the app is already holding the link when they arrive, the flow collapses to a single tap.

Design constraints:
- Reading the clipboard requires a permission prompt on iOS. Design the moment we ask for it — not on first launch, but the first time the user pastes a link manually, where the value is self-evident.
- Never save silently. Always show what we found and let the user confirm. A silently-saved wrong link is worse than a tap.
- Handle rejection gracefully. If permission is denied, the manual paste field must remain fully functional and unmarred by nag prompts.

**FR-1.3 — Share target (Android / progressive enhancement).** Register as a Web Share Target so the app appears in Android's native share sheet. Where available, this is the primary capture path.

**FR-1.4 — Batch import.** Accept multiple URLs at once, pasted as a list. Needed for the initial migration of an existing Instagram Saved collection — a first-run task involving potentially hundreds of reels. Process as a queue with visible progress, resumable if the user closes the app.

**FR-1.5 — Optimistic save.** The recipe appears in the library *immediately* on submit, in a pending state. Extraction happens in the background. The user is never made to watch a spinner before they can carry on.

**FR-1.6 — Background processing.** Extraction continues if the user navigates away or closes the app. On return, results are reflected. If the app cannot run work in the background on a given platform, the queue resumes on next open — and pending items are clearly marked as waiting rather than failed.

### 5.2 Library and organisation

**FR-3.1 — Library view.** All recipes, newest first by default. Two presentations, user-toggleable:
- **Grid** — thumbnail-led, visual, closest to how the user remembers reels ("the one with the orange sauce"). Recommend as default.
- **List** — denser, text-led, better for scanning many recipes.

**FR-3.2 — Search.** Full-text across title, ingredients, steps, tags, creator, and notes. Must be fast enough to filter as the user types. Must tolerate misspellings and partial words — a user searching "corriander" should find "coriander".

**FR-3.3 — Filters.** Combinable, and never modal-only — the user should be able to see what's filtered at a glance and clear it in one tap.
- Cuisine, meal type, total time (bucketed: <15, 15–30, 30–60, 60+ min), tags, status, creator, date saved

**FR-3.4 — Ingredient search ("what can I cook?").** Enter ingredients on hand; get recipes ranked by match. Show partial matches with what's missing ("you have 5 of 7 — missing cream, paprika"). This is the feature that turns a passive archive into something the user opens on purpose, and it deserves prominence in the IA rather than burial in a filter panel.

**FR-3.5 — Collections.** User-defined groupings. A recipe can be in many. Simple, manual, no auto-curation in v1.

**FR-3.6 — Tags.** Free-form, with autocomplete from existing tags to prevent near-duplicates ("quick" vs "quick meals"). Bulk tag management: rename a tag everywhere, merge two tags, delete a tag.

**FR-3.7 — Auto-categorisation.** On extraction, suggest cuisine, meal type, and tags. Always suggestions, never silent assignment — present them as dismissible chips the user accepts or rejects. Wrong auto-tags erode trust in the library faster than absent ones.

**FR-3.8 — Favourites.** A single-tap star, surfaced as a top-level filter.

**FR-3.9 — Cooked history.** Mark a recipe as cooked, with a date and optional rating and note. Enables "recently cooked", "never tried", and "favourites by rating" — and answers the genuinely useful question "did I like this when I made it?"

**FR-3.10 — Bulk actions.** Multi-select in the library for: tag, add to collection, delete, re-extract. Essential after a batch import, where the user is triaging dozens of entries at once.

**FR-3.11 — Needs-attention queue.** A dedicated view of `needs_attention` and `partial` recipes, so the user can work through failures deliberately rather than stumbling across them. Design this as a satisfying, finite task — a queue that empties — not an infinite backlog of shame.

### 5.3 Cooking

**FR-4.1 — Recipe detail view.** Ingredients and steps, clearly separated. Creator attribution with a link back to the original reel — always present, both for credit and because the user will sometimes want to watch the technique.

**FR-4.2 — Cook mode.** A dedicated, distinct mode for use while actually cooking:
- Larger type, high contrast, readable at arm's length on a propped-up phone
- Screen wake lock — the screen must not sleep mid-recipe
- Step-by-step progression with large touch targets, forgiving of wet or imprecise taps
- Ingredients accessible without leaving the current step
- Check off ingredients and steps as you go; state survives an accidental app switch

**FR-4.3 — Serving scaling.** Adjust servings; quantities recalculate. Handle fractions sensibly (1.5 eggs is nonsense — round and flag it, or express as "1–2").

**FR-4.4 — Unit conversion.** Toggle metric/imperial. Store canonical, display converted.

**FR-4.5 — Inline video.** Play the source reel inside the recipe view where technique matters. Embedded via Instagram's standard embed, with graceful fallback to a link if embedding fails or the post is private.

**FR-4.6 — Personal notes.** Per-recipe notes, distinct from extracted content and never overwritten by re-extraction. "Used half the chilli", "needs 10 more minutes". Over time these become the most valuable content in the library — treat them as first-class, not an afterthought field at the bottom.

### 5.4 Data ownership

**FR-5.1 — Export.** Full library export as JSON (complete fidelity) and Markdown (human-readable). One action, no account required, no gating.

**FR-5.2 — Import.** Re-import a previous export. Enables device migration and serves as the disaster-recovery path.

**FR-5.3 — Delete.** Delete individual recipes, and wipe everything. Deletion is immediate and complete.

**FR-5.4 — No lock-in.** The user's data is theirs. Export must never be degraded, delayed, or used as leverage. This is a personal tool; treating the user's own recipes as hostage would be absurd.

---

## 6. Non-functional requirements

### 6.1 Cost — the hard constraint

**NFR-1.1 — Zero marginal cost.** Total running cost must be £0/month at personal scale. Every architectural choice is subordinate to this. Where a paid service would be convenient, the design must accommodate the free alternative's limitations instead.

**NFR-1.2 — Free-tier headroom.** All infrastructure on permanently-free tiers, with usage staying below ~50% of any free-tier limit at expected volume (est. 20–50 saves/month, ~500 recipes in year one). The 50% margin is deliberate: free tiers shrink, and the app must survive a tier being halved without becoming a bill.

**NFR-1.3 — No surprise bills.** No service that can auto-charge on overage. Prefer services that hard-stop at the free limit over those that bill for it. A broken app is recoverable; an unexpected invoice violates the product's core premise.

**NFR-1.4 — Graceful quota exhaustion.** If a free-tier quota is exhausted (e.g. monthly transcription minutes), the app degrades to the next tier down rather than erroring. Tier 2 unavailable means everything falls to Tier 3 — still saved, still usable, retry available next cycle. Design needs a clear, non-alarming way to say "audio extraction is paused until the 1st".

**NFR-1.5 — No app-store fees.** Reinforces the PWA decision in §3.

### 6.2 Performance

| Metric | Target |
|---|---|
| Time to interactive (repeat visit) | < 1.5s |
| Save acknowledged (optimistic) | < 200ms |
| Tier 1 extraction complete | < 5s (p50), < 15s (p95) |
| Tier 2 extraction complete | < 60s (p50), < 180s (p95) |
| Search results | < 100ms up to 1,000 recipes |
| Library scroll | 60fps |

**NFR-2.1 — Perceived over actual.** Tier 2 is slow and there is no fixing that — audio must be fetched, transcribed, translated, and parsed. Design's job is to make the wait invisible: the user saves and moves on (FR-1.5), and the result arrives later. The user should never sit and watch a two-minute progress bar.

**NFR-2.2 — Progressive results.** Show partial results as they arrive. Title and thumbnail land in seconds; ingredients and steps follow. A recipe filling in progressively feels alive; an empty card that suddenly pops feels broken.

### 6.3 Reliability

**NFR-3.1 — No data loss, ever.** A save is durable the moment it is acknowledged, before any extraction is attempted. This is the product's fundamental promise.

**NFR-3.2 — Offline-capable.** The full library is readable offline. Cooking happens in kitchens with poor signal; a recipe app that needs connectivity to show a saved recipe has failed at its job.

**NFR-3.3 — Offline capture.** Links saved offline queue locally and process when connectivity returns. Queued state is visible and honest — "waiting for connection", not a silent pending spinner.

**NFR-3.4 — Extraction failures are never data failures.** A failed extraction downgrades a tier. It never loses the reel.

**NFR-3.5 — Dependency fragility (stated plainly).** Instagram provides no public API for reading arbitrary reels. Caption and audio access rely on unofficial means that may break without notice, possibly permanently.

This is the product's single largest risk and design must plan for it rather than assume it away:
- Tier 3 always works and requires no external dependency
- Extraction failure is communicated as a *temporary service condition*, not user error — the user did nothing wrong
- Failed items requeue automatically for retry when service is restored
- The app remains genuinely pleasant to use as a pure link organiser

### 6.4 Privacy and legal

**NFR-4.1 — Personal use.** Single user, no third-party data sharing, no analytics on recipe content.

**NFR-4.2 — Attribution always.** Every recipe permanently displays its creator and links to the original reel. The app is a personal reading aid, not a content laundering machine — the creator gets the credit and the traffic.

**NFR-4.3 — No republication.** Content is stored for personal use only. No public sharing surface in v1. Cache thumbnails for offline use and performance, not for redistribution.

**NFR-4.4 — Local-first data.** Recipe data lives primarily on-device. Any sync is for the user's own backup across their own devices.

**NFR-4.5 — Minimal permissions.** Request clipboard access only at the moment of clear value (FR-1.2). No location, contacts, camera, or notifications in v1.

### 6.5 Accessibility

**NFR-5.1 — WCAG 2.1 AA.** Contrast, focus states, semantic structure, screen reader support throughout.

**NFR-5.2 — Kitchen accessibility.** Cook mode must work with wet hands and imprecise taps: minimum 48×48px touch targets, generous spacing, no destructive actions reachable by mis-tap, no swipe-only interactions.

**NFR-5.3 — Dynamic type.** Respect the OS text size setting. Layouts must not break at 200% text.

**NFR-5.4 — Dark mode.** Full support. Cooking often happens in the evening, and a bright white screen in a dim kitchen is genuinely unpleasant.

**NFR-5.5 — Reduced motion.** Honour `prefers-reduced-motion` for all transitions and loading animations.

### 6.6 Maintainability

**NFR-6.1 — Solo-maintainable.** One person, occasionally, in spare time. No component may require routine attention. Prefer boring, stable technology over clever, fragile technology.

**NFR-6.2 — Component isolation.** Extraction tiers, storage, and UI are independently replaceable. When Instagram breaks something, the fix should be confined to one module.

**NFR-6.3 — Observable failures.** When extraction fails, the reason is recorded and inspectable. Debugging a silent failure months later, from memory, is not viable.

---

## 7. States design must specify

An explicit checklist. Every one of these will occur in real use, and an unspecified state becomes a developer's improvisation.

### Extraction states

| State | User sees | Notes |
|---|---|---|
| Queued | Card with pending indicator | Immediately after save |
| Fetching caption | Progress, title/thumbnail may appear | Fast — may flash by |
| Analysing caption | Progress | |
| Extracting audio | Progress with honest expectation | Slowest step — say so |
| Transcribing | Progress | |
| Translating | Progress + detected language | Only when non-English |
| Complete (high confidence) | Full recipe, no fuss | The happy path — celebrate quietly, don't interrupt |
| Complete (partial) | Recipe + gentle "missing steps" affordance | Not an error |
| Link only | Reel card + "add recipe details" invitation | Must feel like a valid outcome, not failure |
| Failed — retryable | Clear cause + retry | Network, rate limit, quota |
| Failed — permanent | Clear cause + manual-entry offer | Private/deleted post |

### Content states

- **Empty library (first run)** — the most important screen in the app. It must teach the paste flow in one glance without a tutorial.
- **Empty search results** — offer to broaden the search or clear filters; never a bare "no results".
- **Empty collection**
- **Single recipe** — layouts must not assume a full grid
- **Very large library (1,000+)** — performance and navigation hold up
- **Long ingredient list (40+)** and **long steps (20+)**
- **Very long single step** — some creators write a paragraph
- **Missing thumbnail** — private post, deleted media, or offline
- **Non-Latin script** in the original — display the source language name correctly

### Error and edge states

- Invalid or non-Instagram URL pasted
- Instagram post is private, deleted, or age-restricted
- Duplicate save (FR-2.2) — reassure, don't scold
- Offline save queued (NFR-3.3)
- Quota exhausted (NFR-1.4)
- Extraction service down (NFR-3.5) — the honest, non-alarming version
- Re-extraction would overwrite manual edits — confirmation required
- Storage nearly full
- Reel contains no recipe at all (a dog video was pasted) — this is fine and should be treated as fine

---

## 8. Information architecture

```
Home / Library ─┬─ Paste bar (persistent, top)
                ├─ Quick filters (favourites, needs attention, recent)
                ├─ Grid / list toggle
                └─ Recipe cards
                        │
Recipe detail ──────────┴─┬─ Ingredients (scalable, checkable)
                          ├─ Steps
                          ├─ Source reel (embedded)
                          ├─ Notes
                          ├─ Metadata (cuisine, time, tags, provenance)
                          └─ → COOK MODE (distinct, full-screen)

Search ────────────────── Text + filters + ingredient match ("what can I cook?")

Collections ───────────── User-defined groups

Needs attention ───────── Triage queue for failed/partial extractions

Settings ──────────────── Export / import / extraction preferences / units / theme
```

Five top-level destinations at most. The paste bar is persistent and never more than one tap away from anywhere in the app.

---

## 9. Design deliverables requested

**Priority 1 — the core loop**
1. Empty state / first run
2. Paste + clipboard detection interaction, including the permission moment
3. Library — grid and list
4. Recipe card — every status variant (complete, partial, link-only, pending, failed)
5. Recipe detail
6. Cook mode
7. The full extraction progress sequence, as a motion study

**Priority 2 — organisation**
8. Search and filters
9. Ingredient match ("what can I cook?")
10. Collections and tag management
11. Needs-attention queue
12. Bulk selection and actions

**Priority 3 — completeness**
13. Every error and empty state in §7
14. Settings, export/import
15. Manual recipe entry and editing
16. Batch import with queue progress

**Cross-cutting**
17. Design system: type scale (including cook-mode scale), colour (light and dark), spacing, iconography
18. Motion principles — particularly for progressive extraction results
19. App icon and splash screen for home-screen install
20. Responsive behaviour: phone → tablet → desktop

---

## 10. Success metrics

Personal product, so these are usage-honest rather than growth metrics.

| Metric | Target |
|---|---|
| Extraction success (Tier 1 or 2) | > 70% of saves |
| Tier 1 alone | > 45% of saves |
| Saves requiring manual correction | < 25% |
| Time from paste to acknowledgement | < 200ms |
| Recipes cooked / recipes saved | > 15% within 90 days |
| Library searches per week | > 3 |
| Reels lost | 0 |

The last one is the only one that is non-negotiable.

The cooked/saved ratio is the real measure of whether this product works. Saving is easy and Instagram already does it. If the user saves 200 recipes and cooks none of them, we have built a prettier version of the problem.

---

## 11. Open questions for design

1. **How prominent should extraction provenance be?** A recipe reconstructed from a noisy translated transcript may contain errors. How do we signal "verify this against the video" without making every recipe look untrustworthy?
2. **What is the emotional register of Tier 3?** A link-only save is a legitimate outcome, not a failure — but it is also less than the user hoped for. It should read as "saved, and you can add details whenever" rather than either a shrug or an apology.
3. **Should cook mode be a mode or a route?** Full-screen takeover with an explicit exit, or a distinct screen in the navigation? Affects wake lock and back-button behaviour.
4. **How much auto-categorisation is welcome before it feels presumptuous?** Suggested tags are useful; a library that silently reorganises itself is unsettling.
5. **What is the first-run experience with an empty library?** No content, no social proof, no tutorial appetite. One well-chosen sentence and a paste field may beat any onboarding sequence.
6. **Should the batch import of the existing Instagram collection be a designed first-run flow?** It is a one-time task of real scale — potentially hundreds of reels — and it is the moment the library becomes worth using.

---

## 12. Post-v1 (context only — do not design)

Listed so design can avoid decisions that would foreclose these, not to expand scope.

- Native iOS app with a proper share extension (removes the paste-flow compromise)
- Meal planning and weekly calendar
- Shopping list generation from selected recipes
- Other sources: TikTok, YouTube, recipe websites
- Multi-device sync
- Sharing a single recipe with another person

---

## Appendix A — Requirements index

**Capture:** FR-1.1 paste · FR-1.2 clipboard detection · FR-1.3 share target · FR-1.4 batch import · FR-1.5 optimistic save · FR-1.6 background processing

**Extraction:** FR-2.1 ingestion · FR-2.2 duplicates · FR-2.3 caption · FR-2.4 audio · FR-2.5 translation · FR-2.6 link fallback · FR-2.7 graceful degradation · FR-2.8 confidence · FR-2.9 re-extraction · FR-2.10 manual entry

**Library:** FR-3.1 library view · FR-3.2 search · FR-3.3 filters · FR-3.4 ingredient match · FR-3.5 collections · FR-3.6 tags · FR-3.7 auto-categorisation · FR-3.8 favourites · FR-3.9 cooked history · FR-3.10 bulk actions · FR-3.11 needs-attention queue

**Cooking:** FR-4.1 detail view · FR-4.2 cook mode · FR-4.3 scaling · FR-4.4 units · FR-4.5 inline video · FR-4.6 notes

**Data:** FR-5.1 export · FR-5.2 import · FR-5.3 delete · FR-5.4 no lock-in

**Non-functional:** NFR-1.x cost · NFR-2.x performance · NFR-3.x reliability · NFR-4.x privacy/legal · NFR-5.x accessibility · NFR-6.x maintainability
