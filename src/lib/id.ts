/**
 * ID generation.
 *
 * `crypto.randomUUID()` is only exposed in a SECURE CONTEXT — HTTPS, or
 * localhost. Serving the dev build over plain HTTP to a phone on the LAN
 * (http://192.168.1.x:5173) is not secure, so the function is simply
 * undefined there and every save throws.
 *
 * That failure mode is invisible on a desktop, because localhost is treated
 * as secure regardless of protocol. This module exists so the save path never
 * depends on it.
 */

/** Hex pairs 00..ff, for fast byte-to-hex without repeated padStart. */
const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * A RFC 4122 version 4 UUID.
 *
 * Uses crypto.randomUUID where available, then crypto.getRandomValues (which
 * IS available in insecure contexts), and only falls back to Math.random if
 * neither exists. IDs are local row keys, never security tokens, so the weak
 * fallback affects collision probability alone — and at a few thousand rows
 * that remains negligible.
 */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;

  if (typeof c?.randomUUID === 'function') {
    return c.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Set the version (4) and variant bits per RFC 4122.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const h = HEX;
  return (
    `${h[bytes[0]!]}${h[bytes[1]!]}${h[bytes[2]!]}${h[bytes[3]!]}-` +
    `${h[bytes[4]!]}${h[bytes[5]!]}-` +
    `${h[bytes[6]!]}${h[bytes[7]!]}-` +
    `${h[bytes[8]!]}${h[bytes[9]!]}-` +
    `${h[bytes[10]!]}${h[bytes[11]!]}${h[bytes[12]!]}${h[bytes[13]!]}${h[bytes[14]!]}${h[bytes[15]!]}`
  );
}
