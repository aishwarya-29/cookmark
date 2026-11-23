import type { Ingredient } from '../data/types';

/**
 * Caption parser — PRD FR-2.3.
 *
 * Built against real captions in tests/fixtures/captions.json. Every rule here
 * exists because a real caption needed it; when the parser breaks on a new
 * format, add the caption as a fixture and the fix becomes a regression test.
 *
 * Qualifying rule (FR-2.3): a caption is a recipe only with >= 2 ingredients
 * AND >= 1 method step. Ingredients but no steps is PARTIAL — saved, flagged,
 * and explicitly NOT passed down to audio.
 */

export interface ParsedCaption {
  title?: string;
  ingredients: Ingredient[];
  steps: string[];
  /** complete = qualifies; partial = ingredients only; none = not a recipe. */
  outcome: 'complete' | 'partial' | 'none';
}

/** Bullet glyphs seen in real captions, plus plain hyphen/asterisk. */
/**
 * Leading list markers, stripped before parsing.
 *
 * The `\d+[.)]` alternative needs its lookahead. Without it the numbered-list
 * branch ate the whole-number part of every decimal quantity: "1.5 eggs"
 * became "5 eggs", and "1.25 kg lamb" became "25 kg lamb" — a tenfold error
 * written silently into the library. A list marker is followed by whitespace
 * or a letter ("1. Chop", "1.Chop"); a decimal point is followed by a digit.
 */
const BULLET_RE =
  /^[\s]*(?:[-–—*•·▪️▫️◾️◽️🔸🔹🔺🔻➤➡️👉✅✔️☑️➕|]\s*|\d+[.)](?=\s|\D|$)\s*)/u;

/**
 * Section headings. The trailing `[-–—:\s]*` matters: real captions write
 * "Ingredients-", "Method:-", "INGREDIENTS :" and everything between.
 */
const INGREDIENT_HEADING_RE =
  /^\s*[\p{Extended_Pictographic}\s]*(?:ingredients?|you(?:'|’)?ll need|what you need|shopping list)\b\s*(?:\([^)]*\))?\s*[-–—:]*\s*$/iu;

const METHOD_HEADING_RE =
  /^\s*[\p{Extended_Pictographic}\s]*(?:method|instructions?|directions?|steps?|how to(?: make)?|preparation|procedure)\b\s*(?:\([^)]*\))?\s*[-–—:]*\s*$/iu;

/**
 * Sub-headings inside an ingredient block. The trailing colon is optional:
 * real captions write both "For Masala Paste:" and "For the Chicken Marinade".
 * Kept short and "For"-anchored so it cannot swallow a real ingredient line.
 */
const SUBHEADING_RE =
  /^\s*[\p{Extended_Pictographic}\s]*for\s+(?:the\s+)?[\w\s'-]{2,40}\s*:?\s*$/iu;

/** Units we recognise, longest-first so "tbsp" wins before "tb". */
const UNITS = [
  'tablespoons', 'tablespoon', 'teaspoons', 'teaspoon', 'tbsps', 'tbsp', 'tbs', 'tsps', 'tsp',
  'kilograms', 'kilogram', 'grams', 'gram', 'kgs', 'kg', 'gms', 'gm', 'g',
  'millilitres', 'milliliters', 'litres', 'liters', 'mls', 'ml', 'l',
  'ounces', 'ounce', 'oz', 'pounds', 'pound', 'lbs', 'lb',
  'cups', 'cup', 'pinches', 'pinch', 'cloves', 'clove', 'inches', 'inch',
  'handfuls', 'handful', 'bunches', 'bunch', 'slices', 'slice',
  'pieces', 'piece', 'cans', 'can', 'tins', 'tin', 'sprigs', 'sprig',
  'sticks', 'stick', 'no\'s', 'nos', 'no',
];
const UNIT_RE = new RegExp(`^(?:${UNITS.join('|')})\\b\\.?`, 'i');

/** Vulgar fractions that appear constantly in real captions. */
const FRACTIONS: Record<string, number> = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

/**
 * Promotional noise — creator call-to-action lines. Matched by prefix with no
 * length cap, because these run long: "Save this recipe and try it today! 🤍
 * Don't forget to like share save this reel & follow @handle for more".
 */
const NOISE_RE =
  /^\s*[\p{Extended_Pictographic}\s]*(?:recipe below|full recipe (?:below|in)|save (?:this|it|for later)|don(?:'|’)?t forget|comment\b|follow (?:me|for|@)|link in bio|tag (?:someone|a friend)|share this|like (?:and|&)|subscribe|dm me|check out|turn on|hit the|credit)\b/iu;

/** A line that is only emoji, punctuation, or decoration. */
const DECORATION_RE = /^[\s\p{Extended_Pictographic}\p{P}\p{S}]*$/u;

function stripHashtags(line: string): string {
  return line.replace(/#[\p{L}\p{N}_]+/gu, '').trim();
}

function isHashtagWall(line: string): boolean {
  const tags = (line.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (tags === 0) return false;
  // A line is a wall if hashtags dominate what's left of it.
  return stripHashtags(line).length < 12 || tags >= 4;
}

function parseQuantity(token: string): number | undefined {
  const t = token.trim();
  if (!t) return undefined;

  // Direct fraction glyph, possibly preceded by a whole number ("1½").
  const glyph = [...t].find((c) => c in FRACTIONS);
  if (glyph) {
    const whole = parseFloat(t.slice(0, t.indexOf(glyph))) || 0;
    return whole + FRACTIONS[glyph]!;
  }
  // "1/2" or "1 1/2"
  const mixed = t.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const whole = mixed[1] ? parseInt(mixed[1], 10) : 0;
    return whole + parseInt(mixed[2]!, 10) / parseInt(mixed[3]!, 10);
  }
  // Ranges ("2-3", "2–3", "4 –5") — take the lower bound, the safer default.
  const range = t.match(/^(\d+(?:\.\d+)?)\s*[-–—]\s*\d+(?:\.\d+)?$/);
  if (range) return parseFloat(range[1]!);

  const plain = t.match(/^\d+(?:\.\d+)?$/);
  return plain ? parseFloat(t) : undefined;
}

/**
 * Parse one ingredient line into parts.
 *
 * Handles both orders seen in the fixtures:
 *   "500 gm chicken"          → quantity-first
 *   "Coriander seeds – 1 tbsp" → item-first, quantity after a dash
 */
export function parseIngredientLine(raw: string): Ingredient | null {
  let line = stripHashtags(raw.replace(BULLET_RE, '')).trim();
  if (!line) return null;

  // Trailing parenthetical note: "Water – 2–3 tbsp (to grind)"
  let note: string | undefined;
  const paren = line.match(/\(([^)]*)\)\s*$/);
  if (paren) {
    note = paren[1]!.trim();
    line = line.slice(0, paren.index).trim();
  }

  // --- Item-first: "Coriander seeds – 1 tbsp" / "Garlic- 4 No's" ---
  const dashSplit = line.match(/^(.{2,}?)\s*[–—-]\s*(.+)$/);
  if (dashSplit) {
    const left = dashSplit[1]!.trim();
    const right = dashSplit[2]!.trim();
    // En and em dashes belong in the class too: "Water – 2–3 tbsp" splits at
    // the first dash, so the range lands here and must be captured whole. Left
    // out, the capture stopped at "2" and the leftover "–3 tbsp" no longer
    // matched UNIT_RE, silently dropping the unit.
    const qtyMatch = right.match(/^([\d½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞./\s\-–—]+)\s*(.*)$/u);
    if (qtyMatch) {
      const quantity = parseQuantity(qtyMatch[1]!);
      const rest = qtyMatch[2]!.trim();
      const unitMatch = rest.match(UNIT_RE);
      if (quantity !== undefined || unitMatch) {
        return {
          ...(quantity !== undefined ? { quantity } : {}),
          ...(quantity === undefined && qtyMatch[1]!.trim()
            ? { quantityText: qtyMatch[1]!.trim() }
            : {}),
          ...(unitMatch ? { unit: unitMatch[0].replace(/\.$/, '') } : {}),
          item: left,
          ...(note ? { note } : {}),
        };
      }
    }
    // "Salt – as needed" — a real qualifier, not a quantity.
    if (right.length <= 24 && !/\d/.test(right)) {
      return { quantityText: right, item: left, ...(note ? { note } : {}) };
    }
  }

  // --- Quantity-first: "500 gm chicken", "1 tbsp ginger garlic paste" ---
  // The separator class carries en and em dashes as well as the hyphen, so a
  // range typed as "2–3 tbsp" is captured whole. parseQuantity already accepts
  // all three; without them here the capture stopped at "2" and the remainder
  // ("–3 tbsp oil") was taken as the item name.
  const qtyFirst = line.match(/^([\d½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]+(?:[./\s\-–—]\d+)*)\s*(.*)$/u);
  if (qtyFirst) {
    const quantity = parseQuantity(qtyFirst[1]!);
    let rest = qtyFirst[2]!.trim();
    const unitMatch = rest.match(UNIT_RE);
    let unit: string | undefined;
    if (unitMatch) {
      unit = unitMatch[0].replace(/\.$/, '');
      rest = rest.slice(unitMatch[0].length).trim();
    }
    rest = rest.replace(/^of\s+/i, '').trim();
    if (rest) {
      // Trailing ", finely sliced" is a note, not part of the item.
      const comma = rest.match(/^(.+?),\s*(.+)$/);
      if (comma && comma[2]!.length < 40) {
        return {
          ...(quantity !== undefined ? { quantity } : {}),
          ...(unit ? { unit } : {}),
          item: comma[1]!.trim(),
          note: note ? `${comma[2]!.trim()}, ${note}` : comma[2]!.trim(),
        };
      }
      return {
        ...(quantity !== undefined ? { quantity } : {}),
        ...(unit ? { unit } : {}),
        item: rest,
        ...(note ? { note } : {}),
      };
    }
  }

  // No quantity at all — still an ingredient ("Oil", "Garlic").
  return { item: line, ...(note ? { note } : {}) };
}

/**
 * Cooking verbs, matched only at the START of a line. A step is an imperative
 * ("Add the chicken"); an ingredient may merely mention a verb in a note
 * ("Water – 2–3 tbsp (to grind)"), which must not be mistaken for one.
 */
const LEADING_VERB_RE =
  /^(?:then\s+|now\s+|next\s+|finally\s+)?(?:add|mix|stir|heat|cook|fry|bake|boil|serve|pour|blend|grind|marinate|garnish|roast|simmer|chop|whisk|knead|preheat|combine|transfer|remove|cover|repeat|coat|massage|take|put|place|bring|drain|soak|rest|cut|slice|dice|crush|peel|wash|rinse|sprinkle|season|adjust|switch|turn|allow|let)\b/i;

/** Does this line plausibly name an ingredient rather than describe an action? */
function looksLikeIngredient(line: string): boolean {
  // Parentheticals are notes ("(to grind)") and must not drive this decision.
  const t = line.replace(/\([^)]*\)/g, '').trim();
  if (!t) return false;
  if (t.length > 90) return false;
  if (t.split(/\s+/).length > 12) return false;
  // A sentence ending in a full stop is prose, not an ingredient line.
  if (/[.!?]$/.test(t) && t.split(/\s+/).length > 5) return false;
  return !LEADING_VERB_RE.test(t);
}

/** A title should fit a card. Beyond this it is prose, not a name. */
const MAX_TITLE_CHARS = 60;

/**
 * Opening lines that are engagement hooks, not dish names. Creators lead with
 * these constantly ("WAIT FOR THE END…", "Broke but Bougie Ep. 3"), and taking
 * them as the title makes a library of recipes unbrowsable.
 */
const HOOK_RE =
  /^\s*(?:wait for (?:it|the end)|watch (?:till|until) the end|you (?:won't|will not) believe|pov\b|storytime|new (?:video|recipe|series)|trust me|listen\b|okay so\b|guys\b)/iu;

/**
 * Series and episode labels, which can appear anywhere in a short opening
 * line: "Broke but Bougie Ep. 3", "Day 12 of cheap dinners".
 */
const SERIES_RE = /\b(?:ep(?:isode)?\.?\s*\d+|part\s*\d+|day\s*\d+)\b/iu;

/**
 * Reduce a caption's opening line to something usable as a title.
 *
 * Many creators open with a paragraph rather than a dish name — one real
 * caption began with 500 characters of preamble about tomato gojju, which
 * became the entire title. Cut to the first sentence or clause, and give up
 * rather than truncating mid-word into nonsense.
 */
function tidyTitle(line: string): string | undefined {
  let t = line.replace(/[—–-]\s*(?:quick|simple|easy).*$/i, '').trim();
  if (t.length <= MAX_TITLE_CHARS) return t || undefined;

  // First sentence, if it is short enough to be a name.
  const sentence = t.split(/(?<=[.!?])\s/)[0]?.trim();
  if (sentence && sentence.length <= MAX_TITLE_CHARS) {
    return sentence.replace(/[.!?]+$/, '');
  }

  // Otherwise the first clause, split on a comma or dash.
  const clause = t.split(/[,;:]|\s[—–-]\s/)[0]?.trim();
  if (clause && clause.length <= MAX_TITLE_CHARS) return clause;

  // Nothing short enough: a truncated paragraph is a worse title than none,
  // and the caller falls back to the creator handle plus date.
  return undefined;
}

export function parseCaption(caption: string): ParsedCaption {
  const rawLines = caption.split(/\r?\n/);

  // --- Title: first substantial non-noise line ---
  let title: string | undefined;
  for (const l of rawLines) {
    const clean = stripHashtags(l)
      .replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+/u, '')
      .trim();
    if (clean.length < 3 || NOISE_RE.test(clean) || /^[.\-–—_=]+$/.test(clean)) continue;
    // A section heading is never a title — reaching one means the caption had
    // no usable name, and a fallback beats labelling a recipe "Ingredients:".
    if (INGREDIENT_HEADING_RE.test(clean) || METHOD_HEADING_RE.test(clean)) break;
    // Skip engagement hooks and series labels; the dish name usually follows.
    if (HOOK_RE.test(clean) || SERIES_RE.test(clean)) continue;
    title = tidyTitle(clean);
    if (title) break;
  }

  // --- Walk lines, tracking which section we're in ---
  const ingredients: Ingredient[] = [];
  const steps: string[] = [];
  type Mode = 'unknown' | 'ingredients' | 'method';
  let mode: Mode = 'unknown';
  let pendingStep = '';

  const flushStep = () => {
    const s = pendingStep.trim();
    if (s.length > 3) steps.push(s);
    pendingStep = '';
  };

  for (const raw of rawLines) {
    const line = raw.trim();

    if (!line || DECORATION_RE.test(line)) {
      // Blank, divider, or emoji-only line ends a multi-line step.
      if (mode === 'method') flushStep();
      continue;
    }
    if (isHashtagWall(line)) continue;
    if (NOISE_RE.test(line)) continue;

    if (INGREDIENT_HEADING_RE.test(line)) {
      if (mode === 'method') flushStep();
      mode = 'ingredients';
      continue;
    }
    if (METHOD_HEADING_RE.test(line)) {
      if (mode === 'method') flushStep();
      mode = 'method';
      continue;
    }
    // "For Masala Paste:" / "For the Chicken Marinade" — a label within the
    // ingredient block, not an ingredient. Requiring no digits keeps this from
    // swallowing a real line like "For 4 people use 2 onions".
    if (mode === 'ingredients' && SUBHEADING_RE.test(line) && !/\d/.test(line)) continue;

    const cleaned = stripHashtags(line).trim();
    if (!cleaned) continue;

    if (mode === 'ingredients') {
      // A long imperative line inside an ingredient block means the method
      // started without a heading.
      if (!looksLikeIngredient(cleaned.replace(BULLET_RE, ''))) {
        mode = 'method';
        pendingStep = cleaned.replace(BULLET_RE, '');
        continue;
      }
      const ing = parseIngredientLine(cleaned);
      if (ing?.item) ingredients.push(ing);
      continue;
    }

    if (mode === 'method') {
      const isNewBullet = BULLET_RE.test(line);
      if (isNewBullet) {
        flushStep();
        pendingStep = cleaned.replace(BULLET_RE, '');
      } else {
        // Continuation of the previous step.
        pendingStep = pendingStep ? `${pendingStep} ${cleaned}` : cleaned;
      }
      continue;
    }
  }
  if (mode === 'method') flushStep();

  // Drop a step that merely repeats the title.
  const filteredSteps = steps.filter(
    (s) => !title || s.toLowerCase() !== title.toLowerCase(),
  );

  const outcome: ParsedCaption['outcome'] =
    ingredients.length >= 2 && filteredSteps.length >= 1
      ? 'complete'
      : ingredients.length >= 2
        ? 'partial'
        : 'none';

  return {
    ...(title ? { title } : {}),
    ingredients,
    steps: filteredSteps,
    outcome,
  };
}
