/**
 * Tier 1a — LLM caption parsing via Workers AI.
 *
 * Cost (verified against Cloudflare's pricing table, Aug 2026):
 *   llama-3.3-70b-instruct-fp8-fast — 26,668 neurons/M input,
 *   204,805 neurons/M output. A caption is ~600 in / ~400 out ≈ 98 neurons.
 *   Free allowance is 10,000 neurons PER DAY, and it HARD-STOPS with an error
 *   rather than billing (NFR-1.3). 50 saves/month ≈ 4,900 neurons/month.
 *
 * The main risk here is not cost, it is hallucination: a caption with no
 * recipe (a hashtag wall, a dog video) must yield NOTHING rather than a
 * plausible invention. The prompt, the schema, and validateParsed() all exist
 * to enforce that.
 */

export interface LlmIngredient {
  quantity?: number;
  quantityText?: string;
  unit?: string;
  item: string;
  note?: string;
}

export interface LlmParsed {
  title?: string;
  ingredients: LlmIngredient[];
  steps: string[];
  /** Detected language of the caption, ISO name (FR-2.5). */
  sourceLanguage?: string;
  /** True when the model translated the content into English. */
  translated?: boolean;
  /**
   * Category suggestions (FR-3.7). These are proposals for the user to accept
   * or dismiss — never applied automatically.
   */
  cuisine?: string;
  mealType?: string;
  tags?: string[];
}

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'drink']);

export class QuotaExhaustedError extends Error {
  constructor() {
    super('Daily AI allowance used up');
    this.name = 'QuotaExhaustedError';
  }
}

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Ceiling on a single inference. Measured latency on real captions ranges from
 * ~9s (short) to ~45s (1600+ chars) — the long ones are exactly the captions
 * worth parsing, so this must not be tight. Beyond this the call is stuck
 * rather than slow, and falling back to the regex parser beats hanging.
 */
const AI_TIMEOUT_MS = 75_000;

/**
 * Captions beyond this are truncated before parsing. Instagram's own limit is
 * 2200 characters, so this only trims the trailing hashtag wall, which carries
 * no recipe content but does inflate inference time.
 */
const MAX_CAPTION_CHARS = 2400;

const SYSTEM_PROMPT = `You extract recipes from Instagram caption text.

Return ONLY what is genuinely present in the caption. This is the most
important rule. Many captions are promotional and contain no recipe at all —
for those, return empty arrays. Never invent, infer, or complete a recipe from
your own knowledge of cooking. If the caption says "chicken curry" but lists no
ingredients, return no ingredients.

Rules:
- Ingredients may be a bulleted list OR mentioned inline in prose. Extract both.
  "add 1 teaspoon each of turmeric, red chilli powder and salt" yields three
  separate ingredients, each with quantity 1 and unit "teaspoon".
- Ignore hashtags, @mentions, follow/save/like calls to action, and episode or
  series titles.
- Section labels like "For the marinade:" are NOT ingredients.
- Keep step text close to the creator's wording. Do not add steps that are only
  implied.
- If the caption is not in English, translate ingredients and steps into
  English, and report the original language.
- quantity must be a NUMBER when one is stated (convert ½ to 0.5, "2-3" to 2).
  Use quantityText for non-numeric amounts like "a pinch" or "as needed".

When — and only when — you extracted a real recipe, also categorise it. These
are suggestions the user will confirm, so a reasonable inference from the
dish itself is wanted; what is not wanted is inventing detail the caption
cannot support.
- cuisine: the cooking tradition. Infer it from the dish and its ingredients —
  a curry with garam masala and curry leaves is Indian; pasta with basil and
  parmesan is Italian. Be specific where the dish is ("South Indian" rather
  than "Indian") when the evidence supports it. Leave empty only if the dish
  genuinely belongs to no identifiable tradition.
- mealType: exactly one of breakfast, lunch, dinner, snack, dessert, drink.
  Infer from the dish — a chicken curry is dinner, a cake is dessert. Leave
  empty only when it could plausibly be any of them.
- tags: 2-4 short lowercase labels describing how the dish is used —
  "quick", "vegetarian", "one-pot", "high-protein", "party food". Base these
  on what the caption actually says. Do not tag "vegetarian" unless the
  ingredients really are. Do not repeat the cuisine or meal type as a tag.

If the caption contains no recipe, return empty arrays and no categories.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Dish name, or empty if none stated' },
    sourceLanguage: {
      type: 'string',
      description: 'Language of the original caption, e.g. English, Tamil, Hindi',
    },
    translated: { type: 'boolean' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quantity: { type: 'number' },
          quantityText: { type: 'string' },
          unit: { type: 'string' },
          item: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['item'],
      },
    },
    steps: { type: 'array', items: { type: 'string' } },
    cuisine: {
      type: 'string',
      description:
        'Cooking tradition inferred from the dish, e.g. "South Indian", "Italian". Empty string only if the dish belongs to no identifiable tradition.',
    },
    mealType: {
      type: 'string',
      enum: ['breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'drink', ''],
      description: 'Inferred from the dish. Empty string only if genuinely ambiguous.',
    },
    tags: { type: 'array', items: { type: 'string' } },
  },
  // cuisine and mealType are required so the model commits to a judgement
  // rather than silently omitting the field; an empty string is its escape
  // hatch, and validateAgainstCaption drops both when there is no recipe.
  required: ['ingredients', 'steps', 'cuisine', 'mealType', 'tags'],
} as const;

/** Ai binding shape, narrowed to what we use. */
export interface AiBinding {
  run: (
    model: string,
    input: Record<string, unknown>,
  ) => Promise<{ response?: unknown }>;
}

/**
 * Reject output that looks invented rather than extracted.
 *
 * The model occasionally returns a generic recipe when the caption has none.
 * Every ingredient and step must have some textual footing in the caption.
 */
function validateAgainstCaption(parsed: LlmParsed, caption: string): LlmParsed {
  const haystack = caption.toLowerCase();

  const grounded = (text: string): boolean => {
    // A term counts as grounded if a distinctive word from it appears in the
    // caption. Short function words are ignored.
    const words = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4);
    if (!words.length) return true; // e.g. "oil", "salt" — too short to test
    return words.some((w) => haystack.includes(w));
  };

  const ingredients = parsed.ingredients.filter((i) => i.item && grounded(i.item));
  const steps = parsed.steps.filter((s) => s.trim().length > 3 && grounded(s));

  // If most of what came back is ungrounded, treat the whole result as
  // unreliable rather than keeping the fragments.
  const keptRatio =
    parsed.ingredients.length > 0 ? ingredients.length / parsed.ingredients.length : 1;
  if (keptRatio < 0.5) {
    return { ingredients: [], steps: [] };
  }

  // Categories ride on the recipe: if there is no recipe, there is nothing to
  // categorise, and suggesting a cuisine for a hashtag wall would be invention.
  const hasRecipe = ingredients.length > 0 || steps.length > 0;
  const mealType =
    hasRecipe && parsed.mealType && MEAL_TYPES.has(parsed.mealType.toLowerCase())
      ? parsed.mealType.toLowerCase()
      : undefined;
  const cuisine =
    hasRecipe && parsed.cuisine && parsed.cuisine.length <= 30 ? parsed.cuisine : undefined;
  const tags = hasRecipe
    ? [
        ...new Set(
          (parsed.tags ?? [])
            .filter((t) => typeof t === 'string')
            .map((t) => t.toLowerCase().trim())
            .filter((t) => t.length >= 2 && t.length <= 24)
            // Don't duplicate the cuisine or meal type as a tag.
            .filter((t) => t !== cuisine?.toLowerCase() && t !== mealType),
        ),
      ].slice(0, 4)
    : [];

  return {
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(parsed.sourceLanguage ? { sourceLanguage: parsed.sourceLanguage } : {}),
    ...(parsed.translated ? { translated: parsed.translated } : {}),
    ...(cuisine ? { cuisine } : {}),
    ...(mealType ? { mealType } : {}),
    ...(tags.length ? { tags } : {}),
    ingredients,
    steps,
  };
}

export async function parseCaptionWithLlm(
  ai: AiBinding,
  caption: string,
): Promise<LlmParsed> {
  // Don't spend a request on something that obviously has no recipe.
  const withoutTags = caption.replace(/#[\p{L}\p{N}_]+/gu, '').trim();
  if (withoutTags.length < 40) {
    return { ingredients: [], steps: [] };
  }

  // Strip the trailing hashtag wall before inference: it is pure noise and
  // meaningfully slows a long caption down.
  const trimmed = caption.replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, '').trim();
  const input = trimmed.length > MAX_CAPTION_CHARS
    ? trimmed.slice(0, MAX_CAPTION_CHARS)
    : trimmed;

  let raw: unknown;
  try {
    // The AI binding has no built-in timeout. Without this race, a stalled
    // inference hangs the whole request — observed at 900+ seconds — and the
    // client eventually gives up having learned nothing.
    const result = await Promise.race([
      ai.run(MODEL, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Caption:\n\n${input}` },
        ],
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        max_tokens: 1500,
        temperature: 0.1,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI inference timed out')), AI_TIMEOUT_MS),
      ),
    ]);
    raw = result.response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Workers AI reports quota exhaustion as an error; surface it distinctly so
    // the app can degrade to the regex parser rather than reporting a failure
    // (NFR-1.4).
    if (/neuron|quota|limit|429|capacity/i.test(msg)) throw new QuotaExhaustedError();
    throw err;
  }

  const obj =
    typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);

  if (!obj || typeof obj !== 'object') return { ingredients: [], steps: [] };

  const parsed: LlmParsed = {
    ...(typeof obj['cuisine'] === 'string' && obj['cuisine'] ? { cuisine: obj['cuisine'] } : {}),
    ...(typeof obj['mealType'] === 'string' && obj['mealType'] ? { mealType: obj['mealType'] } : {}),
    ...(Array.isArray(obj['tags']) ? { tags: obj['tags'] as string[] } : {}),
    // A title longer than this is prose, not a dish name — drop it and let
    // the client fall back rather than filling a card with a paragraph.
    ...(typeof obj['title'] === 'string' && obj['title'] && obj['title'].length <= 60
      ? { title: obj['title'] }
      : {}),
    ...(typeof obj['sourceLanguage'] === 'string' && obj['sourceLanguage']
      ? { sourceLanguage: obj['sourceLanguage'] }
      : {}),
    ...(obj['translated'] === true ? { translated: true } : {}),
    ingredients: Array.isArray(obj['ingredients'])
      ? (obj['ingredients'] as LlmIngredient[]).filter(
          (i) => i && typeof i.item === 'string' && i.item.trim(),
        )
      : [],
    steps: Array.isArray(obj['steps'])
      ? (obj['steps'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
  };

  return validateAgainstCaption(parsed, caption);
}

