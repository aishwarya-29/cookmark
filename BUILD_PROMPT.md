# Build kickoff prompt

Paste into a fresh Claude Code session, with `PRD.md` in the working directory.

Target: a **walking skeleton** — the full loop end to end, thin. Paste → extract →
save → library → recipe detail → cook mode. Working, not polished.

---

## The prompt

```
Read PRD.md in this directory. You are building this application.

Build a WALKING SKELETON: the complete loop, thin. Paste a reel link →
extract a recipe → save it → see it in a library → open it → cook from it.
Every step real and working. No polish, no features beyond that loop.

I want to be using this on my phone today.

ARCHITECTURE — non-negotiable, driven by the £0/month constraint

  Frontend    Static PWA. Plain TypeScript + Vite. No React, no framework.
              This app is a few screens and a list; a framework is
              overhead I'd have to maintain forever (see NFR-6.1).

  Data        IndexedDB on-device, via Dexie. Local-first (NFR-4.4). The
              library must be fully readable offline (NFR-3.2) — I cook in
              a kitchen with bad signal.

  Extraction  Serverless functions. Cloudflare Workers preferred (generous
              free tier, no cold-start tax, no credit card). Nothing runs
              when idle.

  Hosting     Cloudflare Pages or GitHub Pages. Static, free.

  Cost        £0/month at ~50 saves/month. If any piece of this needs a
              paid tier at that volume, stop and tell me before building
              it — do not silently pick something that bills me.

WHY THE EXTRACTION IS THE HARD PART

Instagram has no public API for reading arbitrary reels. Browser JS can't
fetch instagram.com — CORS blocks it. So extraction has to happen
server-side, and it relies on unofficial access that can break overnight
and stay broken for days.

Build the three-tier cascade from §04 of the PRD:

  Tier 1  CAPTION     Fetch the reel's caption, parse for recipe content.
                      Qualifies only if it yields ≥2 ingredients AND ≥1
                      method step. Ingredients but no steps = PARTIAL:
                      save it, flag it, do NOT fall through to audio.

  Tier 2  AUDIO       Extract audio, transcribe, detect language,
                      translate to English if needed, then parse.

  Tier 3  LINK ONLY   Save whatever metadata survives — thumbnail, handle,
                      raw caption, URL. ALWAYS SUCCEEDS. No external
                      dependency. A total network failure still results in
                      a saved row containing just the URL.

THE RULES THAT GOVERN THE WHOLE BUILD

  1. I NEVER LOSE A REEL. The save is durable the moment it's acknowledged
     — BEFORE any extraction is attempted (NFR-3.1). Write the row first,
     extract second. Get this order wrong and the product is broken.

  2. EACH TIER FAILS INDEPENDENTLY (FR-2.7). Caption breaking must not
     stop audio. Audio breaking must not stop captions. Both breaking =
     everything lands in Tier 3 and the app still works as a link
     organiser. Put each tier behind its own toggle so I can disable a
     broken one without a deploy.

  3. OPTIMISTIC SAVE (FR-1.5). The recipe appears in the library in under
     200ms, in a pending state. Extraction runs in the background. I never
     watch a spinner before carrying on.

  4. FAILURE IS NEVER DATA LOSS (NFR-3.4). A failed extraction downgrades
     a tier. It never loses the reel.

BUILD IT IN THIS ORDER, AND STOP AT EACH CHECKPOINT

  Step 1  Data layer + save path. Schema from §04. Paste a URL → canonical
          form (strip ?igsh= tracking params, handle /reel/ /reels/ /p/
          and share redirects) → duplicate check (FR-2.2) → durable write.
          No extraction yet.
          CHECKPOINT: I can paste links and they persist across reload.

  Step 2  Tier 3 first — the fallback, before the clever tiers. Save with
          whatever metadata is reachable. This is the floor the whole
          product stands on; build it before anything that can fail.
          CHECKPOINT: every paste produces a usable library entry.

  Step 3  Library + recipe detail + cook mode. Plain, unstyled-but-clean.
          Cook mode needs the Wake Lock API — the screen must not sleep
          (FR-4.2) — 48px touch targets, no swipe-only interactions.
          CHECKPOINT: I can cook from a manually-entered recipe.

  Step 4  Tier 1 caption extraction, as a Worker. Real captions are messy:
          emoji bullets (🔸 • ▪️), inline quantities, hashtag walls,
          "recipe below 👇", creator preamble. Discard the noise.
          CHECKPOINT: a real reel link produces a real recipe.

  Step 5  Tier 2 audio. Transcribe, detect language, translate, parse.
          Before writing this, tell me what you plan to use and what it
          costs at 50 saves/month. If it needs an API key, say so and
          tell me exactly which one and where to get it.
          CHECKPOINT: a non-English reel produces an English recipe.

Stop at each checkpoint and show me. Do not build all five and hand me a
pile.

TESTING — only where it earns its place

Unit-test the parsers: URL canonicalisation, caption parsing, ingredient
parsing. These have gnarly real-world inputs and silent failure modes.

Don't test the UI. Solo project, spare-time maintenance (NFR-6.1) — a UI
test suite is a liability I'd have to keep alive.

Save real captions you encounter as fixtures. When the parser breaks on a
new format, I want a regression test, not a bug hunt.

WHAT NOT TO DO

  - No accounts, no auth, no login. Single user, my device (§02).
  - No framework, no component library, no CSS framework.
  - No analytics, no telemetry, no error-reporting SaaS.
  - No features beyond the walking skeleton — no search, no collections,
    no tags, no meal planning. They're in the PRD for later.
  - No paid service, no free trial that converts, nothing that can bill me
    on overage (NFR-1.3).
  - Don't design the UI. Plain, clean, legible, dark mode, 48px targets in
    cook mode. A design system comes later — keep styling in one file so
    it's swappable.

ON THE UI YOU DO BUILD

Functional, not designed — but the states have to be honest, because
they're most of this product's real behaviour:

  - Pending / extracting: show which tier is running. Tier 2 is slow
    (up to 3 min) — say so rather than showing an ambiguous spinner.
  - Link-only: reads as "saved, add details whenever". A valid outcome,
    not a failure. Not red, not an error icon, no apology.
  - Partial: recipe plus a gentle "missing steps" affordance.
  - Failed: distinguish retryable (network, rate limit) from permanent
    (private or deleted post). Never phrase either as my mistake.

Attribution is permanent and always visible — creator handle plus a link
back to the original reel (NFR-4.2), on every entry including link-only.

FIRST, BEFORE ANY CODE

Tell me:
  1. Your Tier 1 approach — specifically how you get a caption out of
     Instagram from a Worker, and how likely it is to break.
  2. Your Tier 2 approach, with the actual cost at 50 saves/month and
     whether I need an API key.
  3. Anything in this prompt you think is wrong.

Then start on Step 1.
```

---

## Follow-ups, in order

**After Step 5, test against reality — this is the real moment of truth:**
```
Here are 10 reel links from my actual saved collection: [paste them]

Run them through the pipeline. Show me a table: which tier each landed in,
what got extracted, and what the parser got wrong. Then fix the top 3
failure patterns.
```

**Then make the capture moment fast (the daily-use unlock):**
```
Now FR-1.2, clipboard detection. On app focus, if the clipboard has an
Instagram URL I haven't saved, offer to save it in one tap.

Ask for clipboard permission the first time I paste manually — where the
value is obvious — not on first launch. If I deny it, manual paste keeps
working with no nagging. Never save silently; always show what you found.

Also add the Web Share Target manifest entry so this works properly from
Android's share sheet.
```

**Then the bulk import (turns it into a real library):**
```
FR-1.4 — batch import. I want to paste my entire Instagram saved
collection at once, potentially hundreds of links. Queue with visible
progress, resumable if I close the app, and it must not hammer the Worker
hard enough to get rate-limited.
```

**Then search, once there's enough in it to need it:**
```
FR-3.2 and FR-3.4 — full-text search across title, ingredients, steps,
creator, notes. Typo-tolerant ("corriander" finds "coriander"). Plus
ingredient match: what can I cook with what I have, showing partial
matches and what's missing.
```

**Then, only once you're actually using it daily:**
```
Make it installable — service worker, manifest, offline-first. The full
library must be readable with no connection.
```

---

## Notes

**Tier 3 before Tier 1 is deliberate, and worth defending if Claude
argues.** It's tempting to build the impressive caption parser first. But
Tier 3 is the floor the product stands on — build it first and every later
failure degrades gracefully by construction, rather than needing a
retrofit.

**The order of the save matters more than anything else in the build.**
Write the row, *then* extract. If extraction runs first and the app
crashes mid-way, the reel is gone — which breaks the one promise the
product makes.

**Push for real numbers at Step 5.** "It's basically free" is not an
answer. Ask for cost at 50 saves/month, what happens at the quota
ceiling, and whether the service can bill on overage. NFR-1.3 exists
because a surprise invoice defeats the entire premise.

**Expect Tier 1 to break periodically.** Not a design flaw — an inherent
property of scraping a platform with no public API. The tier toggles exist
so a break is a config change, not an emergency.

**Run the design session in parallel if you want** (see
`DESIGN_PROMPT.md`). This build keeps styling in one file specifically so
a design system can be dropped in later without touching logic.
