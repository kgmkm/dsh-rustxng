/**
 * Optional fetch provider with charset repair.
 *
 * Why this exists: `@deepseek-ai/dsh-web-fetch-http` reads `charset` from the HTTP
 * `Content-Type` header only. Japanese public sites (JRA, many municipal sites) declare
 * Shift_JIS in `<meta charset="Shift_JIS">` and send `text/html` without a charset
 * parameter, so the built-in provider decodes those bytes as UTF-8 and every kana/kanji
 * becomes U+FFFD. This provider resolves the charset the way a browser does —
 * BOM → HTTP header → `<meta>` — and decodes with `TextDecoder`.
 *
 * It is not a RustXNG feature: the plugin registers it because it already owns a settings
 * card, and a garbled page is exactly the kind of thing a search-then-read workflow hits.
 * Default OFF; `available()` only claims the capability while `web.fetchProvider` names it.
 */
import { WEB_PROVIDER_ERROR, RustxngError } from './rustxng-client.js';

/** Provider id registered in the fetch registry (and written to `web.fetchProvider`). */
export const RUSTXNG_FETCH_PROVIDER_ID = 'rustxng-http';

/** Refuse anything larger than this (bytes) and report `truncated`. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** How much of the body is scanned for a `<meta>` charset declaration. */
const META_SCAN_BYTES = 4096;

/** Content types this provider can decode, mirroring the built-in HTTP fetcher. */
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)$/i;
const TEXT_TYPES = /^(text\/[a-z0-9.+-]+|application\/(json|xml|ld\+json|rss\+xml|atom\+xml|x-ndjson))$/i;

/** Byte-order marks, most specific first. */
const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], charset: 'utf-8' },
  { bytes: [0xfe, 0xff], charset: 'utf-16be' },
  { bytes: [0xff, 0xfe], charset: 'utf-16le' },
];

/** Read the charset parameter of a `Content-Type`, lower-cased. */
export function charsetFromContentType(contentType) {
  if (typeof contentType !== 'string') return undefined;
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  const value = match?.[1]?.trim().toLowerCase();
  return value === undefined || value === '' ? undefined : value;
}

/** Detect a BOM at the start of the body. */
export function charsetFromBom(bytes) {
  for (const bom of BOMS) {
    if (bom.bytes.length > bytes.length) continue;
    if (bom.bytes.every((value, index) => bytes[index] === value)) return bom.charset;
  }
  return undefined;
}

/**
 * Find a charset in the document head.
 *
 * The head is ASCII-compatible for every encoding these sites use, so scanning it as
 * latin1 is safe and lets the declaration be read before deciding how to decode.
 *
 * @param {Uint8Array} bytes Body bytes.
 * @returns {string|undefined} Lower-cased charset label.
 */
export function charsetFromMeta(bytes) {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, META_SCAN_BYTES))).toString('latin1');
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  if (direct !== null) return direct[1].toLowerCase();
  const httpEquiv = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.-]+)/i.exec(head);
  if (httpEquiv !== null) return httpEquiv[1].toLowerCase();
  return undefined;
}

/**
 * Decide how to decode a response body.
 *
 * @param {Uint8Array} bytes Body bytes.
 * @param {string|undefined} contentType Raw `Content-Type` header.
 * @returns {{charset: string, source: 'bom'|'header'|'meta'|'default'}} The chosen charset.
 */
export function detectCharset(bytes, contentType) {
  const bom = charsetFromBom(bytes);
  if (bom !== undefined) return { charset: bom, source: 'bom' };
  const header = charsetFromContentType(contentType);
  if (header !== undefined) return { charset: header, source: 'header' };
  const meta = charsetFromMeta(bytes);
  if (meta !== undefined) return { charset: meta, source: 'meta' };
  return { charset: 'utf-8', source: 'default' };
}

/**
 * Decode bytes with the detected charset, falling back rather than throwing.
 *
 * `TextDecoder` rejects an unknown label; a page that names a charset this runtime does
 * not ship must still render something, so UTF-8 is used and the caller is told.
 *
 * @param {Uint8Array} bytes Body bytes.
 * @param {string} charset Charset label.
 * @returns {{text: string, charset: string, fallback: boolean}}
 */
export function decodeBody(bytes, charset) {
  try {
    const decoder = new TextDecoder(charset, { fatal: false });
    return { text: decoder.decode(bytes), charset, fallback: false };
  } catch {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return { text: decoder.decode(bytes), charset: 'utf-8', fallback: true };
  }
}

/** Classify a `Content-Type` into the seam's body kind, or `undefined` when unsupported. */
export function bodyKind(contentType) {
  const base = String(contentType ?? '').split(';')[0].trim();
  if (base === '') return undefined;
  if (HTML_TYPES.test(base)) return 'html';
  if (TEXT_TYPES.test(base)) return 'text';
  return undefined;
}

/** Build a `WEB_PROVIDER_ERROR` failure. */
function failure(message, options) {
  return new RustxngError(message, WEB_PROVIDER_ERROR, options);
}

/**
 * Create the fetch provider.
 *
 * @param {object} options
 * @param {() => boolean} options.isEnabled Whether the feature switch is on.
 * @param {() => {known: boolean, value?: string}} [options.getSelection] `web.fetchProvider`.
 * @param {(message: string) => void} [options.log] Debug sink.
 * @param {typeof fetch} [options.fetchImpl] Transport override (tests).
 * @returns {{id: string, available: () => boolean, fetch: (request: object, signal?: AbortSignal) => Promise<object>}}
 */
export function createCharsetFetchProvider({ isEnabled, getSelection, log, fetchImpl = fetch } = {}) {
  return {
    id: RUSTXNG_FETCH_PROVIDER_ID,

    available() {
      try {
        if (isEnabled() !== true) return false;
        if (typeof getSelection === 'function') {
          const state = getSelection() ?? { known: false };
          if (state.known === true && state.value !== RUSTXNG_FETCH_PROVIDER_ID) return false;
        }
        return true;
      } catch {
        return false;
      }
    },

    async fetch(request, signal) {
      const url = typeof request?.url === 'string' ? request.url : '';
      if (!/^https?:\/\//i.test(url)) {
        throw failure(`dsh-rustxng can only fetch http(s) URLs, got ${JSON.stringify(url)}`);
      }
      if (signal?.aborted === true) {
        throw new RustxngError('dsh-rustxng fetch was canceled', 'WEB_ABORTED', { cause: signal.reason });
      }

      let response;
      try {
        response = await fetchImpl(url, {
          signal,
          redirect: 'follow',
          headers: { 'user-agent': 'dsh-rustxng', accept: 'text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.1' },
        });
      } catch (error) {
        throw failure(`could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }

      const contentType = response.headers.get('content-type') ?? undefined;
      const kind = bodyKind(contentType);
      if (kind === undefined) {
        throw failure(
          `${url} returned an unsupported content type (${contentType ?? 'none'}); ` +
            'this provider decodes HTML and text only.',
        );
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      const truncated = buffer.length > MAX_BODY_BYTES;
      const bytes = truncated ? buffer.subarray(0, MAX_BODY_BYTES) : buffer;
      const { charset, source } = detectCharset(bytes, contentType);
      const { text, charset: used, fallback } = decodeBody(bytes, charset);

      if (source === 'meta' || source === 'bom') {
        log?.(`[rustxng] fetch ${url}: decoded as ${used} from ${source}${fallback ? ' (fallback)' : ''}`);
      }

      return {
        url: response.url || url,
        statusCode: response.status,
        body: { kind, content: text },
        truncated,
      };
    },
  };
}
