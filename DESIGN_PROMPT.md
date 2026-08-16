# Design kickoff prompt

Paste into a fresh Claude session, with `PRD.md` in the working directory.

---

## The prompt

```
Read PRD.md in this directory. You are the design lead for this product.

Build a clickable HTML prototype of the Priority 1 screens (deliverables 1–7
in §09). Not static mockups — a real prototype I can click through, with
fake data, running from a single self-contained HTML file.

CONTEXT YOU NEED

Reel Recipes is a personal recipe library. I paste an Instagram reel link,
it extracts the recipe from the caption — or failing that from the spoken
audio, translating to English — and files it into a searchable library.
Single user (me), mobile-first PWA, must cost £0/month to run.

The governing rule: I never lose a reel. Extraction is best-effort and
fails often. Saving never fails.

THE THREE MOMENTS — design these as genuinely different contexts

  Capture   In Instagram, mid-scroll, 3 seconds of attention. Speed only.
  Organise  Sofa, later, relaxed. Bulk actions, fixing bad extractions.
  Cook      Kitchen, phone propped up, hands wet. Arm's-length legibility,
            no accidental taps, screen must not sleep.

Most recipe apps get the cook moment wrong by treating it as a reading
view. It gets its own mode.

WHAT TO BUILD

  1. Empty state / first run — no content, no tutorial appetite. Teach the
     paste flow in one glance.
  2. Paste + clipboard detection, including the permission moment (FR-1.2 —
     read this one carefully, it's the highest-leverage interaction in the
     product and what makes a PWA competitive with a native share sheet).
  3. Library — grid and list, toggleable.
  4. Recipe card in every status: complete, partial, link-only, pending,
     failed.
  5. Recipe detail.
  6. Cook mode.
  7. The extraction progress sequence as real motion, not a spinner.

THE HARD PART, AND WHY I'M HIRING YOU FOR IT

Extraction has three tiers that cascade: caption (high confidence) → audio
+ translation (medium) → link-only (always succeeds, no dependency).

Instagram has no public API. Caption and audio access rely on unofficial
means that can break overnight and stay broken for days. So:

  → Sketch the library as if 100% of entries were link-only saves. If that
    view is depressing or useless, the design leans too hard on extraction
    succeeding. This is the single most important test of the design.

  → A link-only save is a VALID OUTCOME, not a failure. It should read as
    "saved, add details whenever" — not a shrug, not an apology, not red.

  → Extraction failure is a temporary service condition. I did nothing
    wrong. Never phrase it as user error.

Show provenance (caption / audio / translated / manual) so I know how much
to trust a recipe — without making every recipe look untrustworthy.

CONSTRAINTS

  - Mobile-first. Design at 390px, then show it holding up at desktop.
  - Light and dark, both first-class. I cook in the evening.
  - Cook mode: 48px minimum touch targets, no swipe-only interactions,
    nothing destructive reachable by mis-tap.
  - Respect prefers-reduced-motion.
  - Real content throughout — actual recipes, actual creator handles,
    actual messy captions with emoji bullets and hashtag walls. No lorem,
    no "Recipe Title Here".

HOW I WANT YOU TO WORK

Before writing code, give me a short design plan: palette as 4–6 named hex
values, typefaces for display / body / utility, and the layout concept in
two sentences. Justify choices against THIS subject — a kitchen-context
recipe app — not against generic app conventions.

Then flag anything in the plan that reads like the default you'd produce
for any similar app, and change it.

Then build. One self-contained HTML file, no external assets — inline the
CSS, use system fonts or inline a webfont as a data URI.

Do not design §12 (post-v1). Do not add features not in the PRD — if you
think something is missing, tell me rather than building it.

Start with the design plan.
```

---

## Follow-ups, in order

Once the Priority 1 prototype is working:

**Pressure-test the degraded state** — the highest-value follow-up:
```
Show me the library with every entry as a link-only save — no extracted
recipes at all. This is a real scenario if Instagram access breaks. Is it
still a good app? If not, fix it.
```

**Then the states checklist** (§07 — the part that usually gets skipped):
```
Design every state in §07 of the PRD: extraction states, content states,
error and edge states. These are what a developer improvises badly when
undefined. Include the awkward ones — duplicate save, quota exhausted,
re-extraction would overwrite my manual edits, and I pasted a dog video.
```

**Then Priority 2** (deliverables 8–12):
```
Now Priority 2 — search and filters, ingredient match, collections and tag
management, needs-attention queue, bulk actions.

Give ingredient match ("what can I cook with chicken and 20 minutes?")
real prominence. It's what turns a passive archive into something I open
on purpose. Don't bury it in a filter panel.
```

**Then the system** (deliverable 17):
```
Extract what you've built into a documented design system: type scale
including the cook-mode scale, colour tokens for both themes, spacing,
iconography. This is what engineering builds from.
```

---

## Notes

**Keep the prototype clickable, not static.** Screens you can click through
surface flow problems that flat mockups hide — especially the paste →
pending → progressive-fill sequence, which is mostly a *timing* problem.

**Push back on the first design plan.** The first pass tends toward
conventional choices. Asking "why this and not something specific to a
kitchen context?" reliably gets a better second pass.

**Resolve the six open questions in §11 as you go** — they're genuine
unknowns, not rhetorical. #2 (the emotional register of a link-only save)
and #5 (first run with an empty library) matter most.

**Before engineering starts,** verify the free-tier claims in NFR-1.x
against current provider limits. Those numbers are asserted in the PRD, not
verified, and the 50%-headroom rule in NFR-1.2 depends on real figures.
