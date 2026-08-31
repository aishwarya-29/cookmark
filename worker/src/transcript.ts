/**
 * Fetching a spoken transcript for a reel.
 *
 * Instagram gives no route to the media from a datacentre IP — every one was
 * tested and closed — so this delegates to a third party that maintains the
 * logged-in sessions and residential proxies needed to reach it.
 *
 * Measured quality on real reels: excellent on clear English narration
 * (2,100+ characters of usable method), poor on Tamil/Telugu and on
 * code-switched speech. The parser downstream is told to treat its output as
 * unreliable and to mark what it inferred.
 */

export class TranscriptUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptUnavailableError';
  }
}

export interface TranscriptResult {
  text: string;
  /** BCP-47-ish code the provider detected, e.g. "en", "ta". */
  lang?: string;
  segments: number;
}

const TIMEOUT_MS = 120_000;

export async function fetchTranscript(
  reelUrl: string,
  apiKey: string,
): Promise<TranscriptResult> {
  const endpoint = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(reelUrl)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new TranscriptUnavailableError(
      aborted ? 'Transcription timed out' : 'Could not reach the transcription service',
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new TranscriptUnavailableError('Transcription key is missing or invalid');
  }
  if (res.status === 402 || res.status === 429) {
    // Free allowance spent, or rate limited. Both resolve with time or a
    // plan change; neither is the user's fault.
    throw new TranscriptUnavailableError('Monthly transcription allowance used up');
  }
  if (!res.ok) {
    throw new TranscriptUnavailableError(`Transcription service returned ${res.status}`);
  }

  const body = (await res.json().catch(() => null)) as {
    lang?: string;
    content?: unknown;
    error?: string;
  } | null;

  if (!body || body.error) {
    throw new TranscriptUnavailableError('No transcript available for this reel');
  }

  // `content` is either a list of timestamped segments or a plain string.
  let text = '';
  let segments = 0;
  if (Array.isArray(body.content)) {
    const parts = (body.content as { text?: string }[])
      .map((s) => (typeof s?.text === 'string' ? s.text : ''))
      .filter(Boolean);
    text = parts.join(' ');
    segments = parts.length;
  } else if (typeof body.content === 'string') {
    text = body.content;
    segments = 1;
  }

  if (!text.trim()) {
    throw new TranscriptUnavailableError('This reel has no speech to transcribe');
  }

  return { text: text.trim(), ...(body.lang ? { lang: body.lang } : {}), segments };
}
