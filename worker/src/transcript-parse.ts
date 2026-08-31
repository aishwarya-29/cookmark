import { QuotaExhaustedError, type AiBinding, type LlmParsed } from './llm-parse';

/**
 * Tier 2 — parsing a spoken transcript into a recipe.
 *
 * This deliberately relaxes the rule that governs caption parsing. A caption
 * is written text, so anything the model adds is invention and gets rejected.
 * A transcript is speech: disfluent, mis-transcribed, and full of quantities
 * that arrive as "a little bit" or garbled ASR noise. Demanding the same
 * textual grounding would reject every real transcript.
 *
 * So here the model IS allowed to infer — to normalise "pothi" back to a
 * plausible spice, to turn "cook it till it's done" into a step. The safeguard
 * is not suppression but HONESTY: everything produced this way is marked
 * unverified, and the UI presents it as a draft to check against the reel
 * rather than as a known-good recipe.
 */

/**
 * Llama 4 Scout, not the 70B used for captions.
 *
 * Benchmarked on real transcripts: llama-3.3-70b and gpt-oss-120b both
 * identified the dish but returned ZERO ingredients and steps every time —
 * they decline to reconstruct from a source they cannot verify. Scout does
 * the reconstruction this tier needs, and is faster (5-7s vs 20s+).
 */
const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const AI_TIMEOUT_MS = 75_000;
const MAX_TRANSCRIPT_CHARS = 6000;

/**
 * Below this there is no plausible recipe — usually song lyrics or a hook.
 * Raised from 150 after a short lyric produced a fully invented curry: a
 * genuine spoken recipe runs to hundreds of characters, so this costs
 * nothing real and closes the fabrication path.
 */
const MIN_TRANSCRIPT_CHARS = 300;

const SYSTEM_PROMPT = `You reconstruct a cooking recipe from the spoken
transcript of a short cooking video. The transcript comes from automatic
speech recognition and is often poor: words are mis-heard, ingredient names
are mangled, and the speaker may switch between English and an Indian
language mid-sentence.

Your job is to produce the most plausible recipe the speaker was describing.

You ARE allowed to:
- Correct obvious mis-transcriptions to the ingredient the speaker clearly
  meant. Indian cooking words are frequently mangled by ASR — for example a
  nonsense token repeated where a spice belongs is usually one of the common
  ones (jeera, dhania, haldi, garam masala, mustard seeds, curry leaves).
- Infer a normal cooking step the speaker implied but did not spell out.
- Convert vague amounts to typical ones for the dish.
- Translate anything spoken in another language into English.

IMPORTANT: if you can tell what dish is being made, you MUST return a usable
recipe for it, even when the transcript is badly mangled. The cook will check
it against the video, so an approximate recipe they can correct is far more
useful than empty arrays. Returning a title with no ingredients and no steps
is a failure — either give the recipe, or return nothing at all.

Where the transcript is too garbled to follow, fall back to a standard
preparation of that dish and mark the confidence "low", listing what you
filled in under "assumptions".

You must NOT:
- Invent a different dish. Stay with what the speaker is plainly cooking.
- Produce a recipe when the transcript contains no cooking at all. Song
  lyrics, greetings, or pure promotion must return empty arrays and no title.
- Repeat an obviously mangled token as if it were a real ingredient. Replace
  it with what was most likely meant, or leave it out.

Set "confidence" honestly:
- "high"   the transcript was clear and the recipe is well supported
- "medium" the gist is clear but quantities or details were inferred
- "low"    heavily mis-transcribed; this is a best guess

Set "assumptions" to a short list of the specific things you inferred rather
than heard, so the cook knows what to check against the video.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sourceLanguage: { type: 'string' },
    translated: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', ''] },
    assumptions: { type: 'array', items: { type: 'string' } },
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
    cuisine: { type: 'string' },
    mealType: {
      type: 'string',
      enum: ['breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'drink', ''],
    },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['ingredients', 'steps', 'confidence'],
} as const;

export interface TranscriptParsed extends LlmParsed {
  confidence?: 'high' | 'medium' | 'low';
  /** What the model inferred rather than heard, for the user to check. */
  assumptions?: string[];
}

/**
 * Does this transcript plausibly describe cooking at all?
 *
 * Cheap guard so song lyrics and greetings never reach the model. One of the
 * test reels transcribed to 84 characters of song, and inferring a recipe
 * from that would be pure fabrication.
 */
export function looksLikeCooking(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TRANSCRIPT_CHARS) return false;

  const t = trimmed.toLowerCase();

  // English cues, plus romanised and native-script Indian cooking words. The
  // English-only list rejected real Tamil recipe transcripts outright — the
  // exact reels this tier exists for — because their cooking vocabulary never
  // appears in English.
  const CUES = [
    'add', 'cook', 'fry', 'boil', 'heat', 'mix', 'stir', 'chop', 'grind',
    'masala', 'oil', 'salt', 'onion', 'tomato', 'spoon', 'cup', 'minute',
    'pan', 'flame', 'water', 'powder', 'paste', 'roast', 'marinate', 'serve',
    'recipe', 'ingredient', 'tsp', 'tbsp', 'gram', 'chicken', 'rice', 'dough',
    // Romanised Indian cooking terms, common in code-switched speech.
    'vengaya', 'thakkali', 'kothamalli', 'pudhina', 'jeera', 'dhania',
    'haldi', 'mirchi', 'chutney', 'chattani', 'sambar', 'kuzhambu', 'poriyal',
    'thalicha', 'thaalika', 'kadai', 'kadhai', 'tadka', 'ghee', 'dal', 'atta',
    'idli', 'dosa', 'biryani', 'curry', 'podi', 'molagai', 'puli',
  ];
  let hits = CUES.filter((c) => t.includes(c)).length;

  // Native-script cooking words, so a transcript that was never romanised
  // still qualifies.
  const NATIVE = [
    'வெங்காய', 'தக்காளி', 'மிளகா', 'உப்பு', 'எண்ணெய்', 'சமை', 'வதக்',
    'பொடி', 'கறி', 'மசாலா', 'தாளி',
    'ఉల్లి', 'టమాటా', 'కారం', 'ఉప్పు', 'నూనె', 'వండ', 'మసాలా', 'పొడి',
    'प्याज', 'टमाटर', 'नमक', 'तेल', 'मसाला', 'पकाओ', 'भून',
  ];
  hits += NATIVE.filter((c) => trimmed.includes(c)).length;

  // A long transcript carrying substantial non-Latin script is speech in
  // another language; the model is far better placed than a keyword list to
  // judge whether it describes cooking. The length floor matters: given 84
  // characters of Tamil song lyrics, the model happily invented a complete
  // 13-ingredient mutton curry.
  const nonLatin = (trimmed.match(/[\u0900-\u0D7F]/g) ?? []).length;
  if (nonLatin > 60 && trimmed.length >= 400) return true;

  return hits >= 3;
}

export async function parseTranscriptWithLlm(
  ai: AiBinding,
  transcript: string,
): Promise<TranscriptParsed> {
  if (!looksLikeCooking(transcript)) {
    return { ingredients: [], steps: [] };
  }

  const input =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS)
      : transcript;

  let raw: unknown;
  try {
    const result = await Promise.race([
      ai.run(MODEL, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Transcript:\n\n${input}` },
        ],
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        max_tokens: 1800,
        temperature: 0.2,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI inference timed out')), AI_TIMEOUT_MS),
      ),
    ]);
    raw = result.response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/neuron|quota|limit|429|capacity/i.test(msg)) throw new QuotaExhaustedError();
    throw err;
  }

  const obj =
    typeof raw === 'string'
      ? (JSON.parse(raw) as Record<string, unknown>)
      : (raw as Record<string, unknown>);
  if (!obj || typeof obj !== 'object') return { ingredients: [], steps: [] };

  const ingredients = Array.isArray(obj['ingredients'])
    ? (obj['ingredients'] as TranscriptParsed['ingredients']).filter(
        (i) => i && typeof i.item === 'string' && i.item.trim(),
      )
    : [];
  const steps = Array.isArray(obj['steps'])
    ? (obj['steps'] as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 3)
    : [];

  // No recipe means no categories — the same rule as captions.
  const hasRecipe = ingredients.length > 0 || steps.length > 0;
  if (!hasRecipe) return { ingredients: [], steps: [] };

  const conf = typeof obj['confidence'] === 'string' ? obj['confidence'] : '';
  const confidence =
    conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'low';

  return {
    ...(typeof obj['title'] === 'string' && obj['title'] && obj['title'].length <= 60
      ? { title: obj['title'] }
      : {}),
    ...(typeof obj['sourceLanguage'] === 'string' && obj['sourceLanguage']
      ? { sourceLanguage: obj['sourceLanguage'] }
      : {}),
    ...(obj['translated'] === true ? { translated: true } : {}),
    ...(typeof obj['cuisine'] === 'string' && obj['cuisine'] ? { cuisine: obj['cuisine'] } : {}),
    ...(typeof obj['mealType'] === 'string' && obj['mealType']
      ? { mealType: obj['mealType'] }
      : {}),
    ...(Array.isArray(obj['tags'])
      ? { tags: (obj['tags'] as string[]).filter((t) => typeof t === 'string').slice(0, 4) }
      : {}),
    ...(Array.isArray(obj['assumptions'])
      ? {
          assumptions: (obj['assumptions'] as unknown[])
            .filter((a): a is string => typeof a === 'string')
            .slice(0, 6),
        }
      : {}),
    confidence,
    ingredients,
    steps,
  };
}

