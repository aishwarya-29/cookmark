# Cookmark v2 — Product Requirements

**Status:** Draft for approval
**Date:** September 2026
**Supersedes:** nothing. This document sits alongside `PRD.md`, which remains the
constitution. Where the two disagree, v1 wins.

---

## 00. Why there is a v2

v1 asked one question: *can a saved reel become a recipe?* The answer is yes,
and the app that proves it is deployed, offline-capable, and covered by 207
tests.

But v1 built a **library**, and a library is something you add to. The thing
that gets opened on a Tuesday evening is a **kitchen tool** — something that
answers "what am I cooking this week, and what do I need to buy?"

v2 closes that gap. It adds no new dependency on Instagram, spends no money,
and does not revisit the audio problem.

### What we learned from the field

Two findings shaped this document.

**1. The audio gap is the state of the art, not a shortfall.** ReciMe — funded,
paid, with a team — is reported to struggle with "video recipes lacking text
captions". They have not solved what we did not solve. This closes the question
of whether more effort on Tier 2 is warranted. It is not, and v2 contains no
Tier 2 work.

**2. The paid market leader's weakest points are our existing strengths.**
Their users' recurring complaints are: grocery lists that will not merge
duplicate items, fixed grocery categories that cannot be renamed, and a meal
plan that does not feed the shopping list. We already own an ingredient
normaliser (`src/lib/ingredient-terms.ts`) built for search, which makes
merging near-free. We would be better at their headline feature than they are,
on the exact axis their users complain about.

That is the opportunity v2 takes.

---

## 01. Objectives

**O-1. Turn the archive into a weekly habit.** The app should have a reason to
be opened on a Sunday, not only at the moment a reel is saved.

**O-2. Beat the paid competition where they are weak.** Merged grocery lists
and user-editable aisles, because those are the specific documented failures of
the market leader.

**O-3. Break the Instagram monoculture.** Every recipe today enters through one
fragile door. v1's own NFR-3.5 states plainly that this door may close
permanently. A second, independent capture path is risk reduction, not a
feature.

**O-4. Close the one broken promise.** NFR-3.3 (offline capture) is stated in
v1 and unimplemented. It is the only requirement that fails silently rather
than by deliberate deferral.

### Explicit non-objectives

- **No further Tier 2 / audio work.** Ruled out by finding 1 above.
- **No cloud sync, no accounts, no multi-device.** Violates NFR-1.1 and
  NFR-4.4. Export/import remains the honest answer to device migration.
- **No nutrition figures.** ReciMe paywalls this. Doing it properly needs a
  food database we cannot afford; doing it with an LLM produces a confident
  guess, and a wrong calorie count is worse than no calorie count. Revisit only
  with a real data source.
- **No recipe discovery or social features.** v1 NFR-4.3 forbids a public
  surface, and that judgement stands.
- **No grocery delivery integration.** Requires commercial partnerships.

---

## 02. What already exists (verified, not assumed)

Before specifying anything, the following was confirmed in the codebase:

| Capability | Where | Note |
|---|---|---|
| Step check-off in cook mode | `src/ui/cook.ts:112` | **Already built.** Persists across app switches. Removed from scope. |
| Numeric quantity + unit parsing | `src/lib/parse-caption.ts:136` | Produces `{quantity: 1.5, unit: 'tbsp', item: 'chilli oil'}`. Makes scaling cheap. |
| Ingredient name normalisation | `src/lib/ingredient-terms.ts` | `singularise`, `termMatches`, `similarity`. The merge engine already exists. |
| Wake lock | `src/lib/wakelock.ts` | Screen stays on while cooking. |
| Unit conversion | — | Not built. Deferred, see §07. |
| Serving scaler | — | `servings` exists on the type and is never read. |

**One structural blocker.** `textToIngredients` in `src/ui/recipe.ts:29` parses
the edit textarea by storing each whole line as `item`, discarding quantity and
unit. Any recipe the user has hand-edited therefore cannot be scaled or cleanly
merged into a grocery list. This must be fixed before FR-6 or FR-7 can be
trusted, and it is specified as FR-8.

---

## 03. The shape of v2

Three bodies of work, in dependency order.

```
FR-8   Structured ingredient editing        ← unblocks everything below
  │
  ├── FR-6  Meal plan (week grid)
  │     │
  │     └── FR-7  Grocery list  ← the payoff
  │
  └── FR-9  Serving scaler

FR-10  Photo / text import        ← independent, parallel
FR-11  Offline capture            ← independent, small
FR-12  Needs-attention queue      ← independent, small
```

---

## 04. Functional requirements — the weekly loop

### FR-6 — Meal plan

**FR-6.1.** A week view, Monday to Sunday, with three slots per day: breakfast,
lunch, dinner. The current week opens by default.

**FR-6.2.** Assign any saved recipe to any slot. A recipe may appear in
several slots; the same dinner twice in a week is a normal thing to plan, not
an error to prevent.

**FR-6.3.** Assignment must work by tap, not only by drag. ReciMe uses
drag-and-drop; drag targets on a phone are fiddly and v1's NFR-5.2 forbids
swipe-only interaction. Tap a slot, pick from the library. Drag may be added
later as an enhancement, never as the only route.

**FR-6.4.** Navigate to any week, forward or back. Past weeks are readable and
serve as a record of what was cooked.

**FR-6.5.** A planned recipe shows its thumbnail and title in the slot. A slot
must be legible at a glance from across a kitchen.

**FR-6.6.** Removing a recipe from a slot never touches the recipe itself.
Deleting a recipe removes it from every slot it occupies — the same purge
discipline `deleteRecipe` already applies to collections.

**FR-6.7.** The plan is local, offline, and included in export (FR-5.1) and
import (FR-5.2). A meal plan that vanished on device migration would be worse
than no meal plan.

### FR-7 — Grocery list

This is the objective of v2. Everything above exists to make this possible.

**FR-7.1.** Generate a list from a week's plan in one action. Also generate
from an arbitrary set of hand-picked recipes, because not all shopping follows
a plan.

**FR-7.2 — Merge duplicates (critical).** Two recipes each calling for one
onion produce **"2 onions"**, not two lines reading "1 onion". Merging uses the
existing `singularise` / `termMatches` machinery. Where units agree, quantities
sum. Where units differ or cannot be reconciled ("1 tbsp oil" and "oil, as
needed"), keep both on one grouped line rather than inventing a conversion —
a wrong total is worse than an honest pair.

*This is the single most-cited failure of the paid competition. It is the
reason this feature is worth building.*

**FR-7.3 — Aisles, user-editable.** Group items by supermarket section
(produce, dairy, meat, spices, pantry, frozen, other). Categories must be
renameable, reorderable, and re-assignable — an item stuck in the wrong aisle
with no way to move it is ReciMe's second-most-cited complaint. Ship sensible
defaults; let the user override any of them, permanently.

**FR-7.4.** Check items off while shopping. State persists — a list that
forgot itself when the app backgrounded in a supermarket would be useless.

**FR-7.5.** Add and edit items by hand. Not everything on a shopping list comes
from a recipe.

**FR-7.6.** Each generated item records which recipes it came from, viewable on
tap. "Why do I need 400ml coconut milk?" must be answerable.

**FR-7.7.** Regenerating after a plan change must not silently discard
hand-added items or tick states. Reconcile: keep what the user touched, update
what came from recipes, and say what changed.

**FR-7.8.** Fully offline. Shopping happens in supermarkets, which have poor
signal — the same reasoning as v1's NFR-3.2 for cooking.

**FR-7.9.** Share or copy the list as plain text, so it can be sent to whoever
is actually going to the shop.

### FR-8 — Structured ingredient editing *(blocker)*

**FR-8.1.** The edit screen must round-trip quantity, unit, and item. Editing a
recipe today silently downgrades its ingredients to unparsed strings.

**FR-8.2.** Reuse the caption parser (`src/lib/parse-caption.ts`) rather than
writing a second, weaker parser. One parser, one set of tests, one place to fix
a bug.

**FR-8.3.** Where a line cannot be parsed, keep it verbatim in `quantityText`.
Never lose what the user typed in order to force structure onto it.

**FR-8.4.** Existing hand-edited recipes are re-parsed opportunistically on
next edit. No migration sweep over the library — a background rewrite of the
user's own edits is exactly the kind of thing NFR-3.1 exists to prevent.

### FR-9 — Serving scaler *(v1 FR-4.3, now unblocked)*

**FR-9.1.** Adjust servings on the recipe view; quantities recalculate.

**FR-9.2.** Nonsense results are flagged, not printed. "1.5 eggs" becomes
"1–2 eggs". This is v1's original wording and it was right.

**FR-9.3.** Scaling is a **view state, never a write.** The stored recipe keeps
what the source said. A scale factor that quietly overwrote the original would
be unrecoverable.

**FR-9.4.** Unscalable ingredients ("salt to taste", "a handful of coriander")
pass through untouched.

**FR-9.5.** The scale factor carries into the grocery list. Planning to cook
for six must buy for six.

---

## 05. Functional requirements — resilience

### FR-10 — Photo and text import

**Strategic value: this is the only capture path that Instagram cannot break.**

**FR-10.1.** Import a recipe from a photograph — a cookbook page, a handwritten
card, a screenshot of a blog. Uses a Workers AI vision model
(`@cf/meta/llama-3.2-11b-vision-instruct`, confirmed available on the free
tier) via the existing Worker.

**FR-10.2.** Import from pasted plain text. The caption parser already handles
unstructured prose; this is mostly plumbing.

**FR-10.3.** Both paths reuse the existing LLM-to-JSON step, the same schema,
and the same edit screen. New capture, same pipeline.

**FR-10.4.** Photo-derived recipes are marked `unverified` with the existing
draft banner. OCR of handwriting misreads, and the honesty discipline v1
applied to transcripts applies here unchanged.

**FR-10.5.** `extractionMethod` gains `photo` and `text`. `sourceUrl` uses a
synthetic scheme (`photo:`, `text:`) exactly as `manual:` already does, so the
unique index and everything downstream need no special case.

**FR-10.6.** The source image is stored as a blob alongside the recipe, so the
user can check the extraction against the original. Same reasoning as
`rawCaption` and `rawTranscript`.

**FR-10.7.** Quota exhaustion degrades to manual entry with the photo attached,
never to an error. Same discipline as NFR-1.4.

### FR-11 — Offline capture *(closes v1 NFR-3.3)*

**FR-11.1.** Detect offline state. Saves still succeed — that already works and
must not regress.

**FR-11.2.** A recipe saved offline reads **"waiting for connection"**, not a
failure and not a silent spinner. v1's exact words.

**FR-11.3.** On reconnection, queued extractions run automatically.

**FR-11.4.** The queue is visible and manually flushable.

### FR-12 — Needs-attention queue *(v1 FR-3.11)*

**FR-12.1.** A dedicated view of recipes that are `needs_attention`, `partial`,
or `unverified`.

**FR-12.2.** Designed as a queue that empties — a finite, satisfying task, not
an infinite backlog of shame. v1's framing, and it still holds.

**FR-12.3.** Act without leaving the queue: retry, edit, confirm a draft, or
delete.

**FR-12.4.** Hidden entirely when empty. A permanent "0 problems" badge is a
nag.

*Rationale: v2 adds a second draft-producing path (FR-10) to the one that
already exists (Tier 2 audio). Drafts scattered through a library with no way
to find them deliberately is the failure mode this prevents.*

---

## 06. Non-functional requirements

All v1 NFRs carry forward unchanged. These are additions.

**NFR-7.1 — The weekly loop works offline, end to end.** Plan, generate, shop.
No step may require connectivity.

**NFR-7.2 — Merging is conservative.** When two ingredients cannot be merged
with confidence, list both. A wrong total sends the user home without an
ingredient; a redundant line costs three seconds in an aisle. The asymmetry is
not close.

**NFR-7.3 — Scaling never mutates stored data.** See FR-9.3.

**NFR-7.4 — v2 adds no recurring cost.** Meal plan, grocery list, and scaler
are entirely local. Photo import consumes the existing Workers AI free tier,
which hard-stops.

**NFR-7.5 — Schema changes are additive only.** New Dexie stores at v3. The
`recipes` table is not retyped. The database name `reel-recipes` is not
touched. See the standing note in `src/data/db.ts:21`.

**NFR-7.6 — Test the merge engine hard.** Grocery merging is exactly the kind
of logic that fails silently and embarrassingly — in a supermarket, holding a
phone. It gets fixture-based tests in the style of `tests/fixtures/captions.json`,
using real ingredient lists from the existing library.

---

## 07. Explicitly deferred

| Item | Reason |
|---|---|
| **FR-4.4 unit conversion** | Ships naturally alongside FR-9, but low value for a library of Indian recipes that are already metric. Do it if the scaler makes it trivial; do not schedule it. |
| **FR-1.4 batch import** | Blocked by Instagram rate-limiting datacentre IPs, not by effort. Hundreds of URLs would need throttling over hours. Strike from the plan rather than carry as a permanent to-do. |
| **FR-3.10 bulk actions** | Its stated justification in v1 was triage after batch import. With batch import struck, this loses its reason to exist. |
| **FR-3.8 favourites** | Genuinely cheap and genuinely useful, but the meal plan is a stronger answer to "which recipes matter". Reconsider after v2 ships and the plan has been used for a month. |
| **FR-3.1 compact library view** | Stated in v1, one presentation built. Cosmetic. |
| **FR-3.6 tag rename/merge/delete** | Matters at ~40 tags. Not yet. |
| **FR-4.5 inline video** | Instagram's embed needs their JS and frequently fails on Reels. The existing link is the honest version. |
| **Nutrition** | See §01 non-objectives. |

---

## 08. Sequencing

Each phase is independently shippable and leaves the app in a working state.

**Phase A — Structured ingredients (FR-8).**
The blocker. Small, invisible to the user, and everything else depends on it.
Ship alone so a regression in ingredient handling is isolated and obvious.

**Phase B — Meal plan (FR-6).**
New Dexie store at v3. Useful on its own.

**Phase C — Grocery list (FR-7).**
The payoff, and the reason for A and B. The merge engine is the interesting
work; the UI is straightforward.

**Phase D — Scaler (FR-9).**
Cheap once A has landed. Feeds C.

**Phase E — Photo and text import (FR-10).**
Independent of A–D. Could run in parallel, or first, if a break from the
weekly-loop work is wanted. Highest strategic value of anything in this
document, because it is the only item that reduces Instagram dependency.

**Phase F — Offline capture and needs-attention (FR-11, FR-12).**
Both small. Grouped as a cleanup pass. F could precede everything if closing
v1's one broken promise feels more urgent than adding capability — a
defensible choice.

### Recommendation

**A → B → C → D**, then **E**, then **F**.

The weekly loop is one coherent feature and delivers the most obvious change in
how the app is used. Photo import is strategically the most valuable single
item, but it is a second front rather than a completion of the first, and A–D
is a story that ends.

If a different priority applies — closing the v1 gap first, or reducing
Instagram risk first — reorder to **F → A → B → C → D → E** or
**E → A → B → C → D**. Nothing in the dependency graph forbids it.

---

## 09. What success looks like

v2 has worked if, three months on:

- The app gets opened to **plan**, not only to save.
- A grocery list is generated and actually taken to a shop.
- At least one recipe in the library came from a **photograph** rather than a
  reel.
- No recipe has been lost, no bill has arrived, and nothing has needed routine
  attention.

The last line is v1's promise. v2 does not get to break it.
