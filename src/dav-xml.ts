import { XMLParser } from 'fast-xml-parser';

/**
 * The WebDAV/CalDAV XML layer: request bodies out, multistatus documents in.
 *
 * Kept apart from `api.ts` because the two halves have different reasons to be
 * read. `api.ts` is about HTTP — timeouts, ceilings, redirects, TLS. This file is
 * about a document format, and it holds the one genuinely free-form value this
 * server ever puts on the wire (the `text-match` search string) plus the decoder
 * that turns somebody else's characters into ours. Both want their own test file
 * and byte-for-byte comparison against captured requests.
 */

/** Namespace prefixes this server emits. Fixed spelling, on purpose — see below. */
const NS =
  'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:CS="http://calendarserver.org/ns/" ' +
  'xmlns:IC="http://apple.com/ns/ical/"';

/**
 * Every property this server ever asks for, as a closed union.
 *
 * Closed because it is what keeps the request bodies free of caller-supplied
 * names: a `PropName` cannot be a string that came in over the protocol, so the
 * only variable text in any body is the search term, which is escaped.
 */
export type PropName =
  | 'D:resourcetype'
  | 'D:displayname'
  | 'D:getetag'
  | 'D:getcontenttype'
  | 'D:current-user-principal'
  | 'D:principal-URL'
  | 'D:current-user-privilege-set'
  | 'C:calendar-home-set'
  | 'C:calendar-user-address-set'
  | 'C:calendar-description'
  | 'C:supported-calendar-component-set'
  | 'C:calendar-data'
  | 'CS:getctag'
  | 'IC:calendar-color';

/**
 * Escapes a value for XML character data.
 *
 * Beyond the five built-ins this refuses control characters outright rather than
 * encoding them. XML 1.0 cannot represent most of them at all, and the two that
 * matter here — CR and LF — must never reach a `text-match` term, because the
 * server compares them against iCalendar content where a line break is
 * structural. Refusing is honest; encoding would invent a value the caller did
 * not send.
 */
export function escapeXmlText(value: string): string {
  // Everything in C0 except tab, plus DEL and C1. CR and LF are refused with
  // the rest, and that is the point rather than an oversight: a line break is
  // meaningless in a search term and structural in iCalendar.
  // eslint-disable-next-line no-control-regex -- matching them is the point
  if (/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/.test(value)) {
    throw new XmlValueError(
      'the value contains control characters, which cannot appear in a CalDAV ' +
        'request. Remove them and try again.'
    );
  }
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      value
    )
  ) {
    throw new XmlValueError(
      'the value contains an unpaired surrogate and is not valid text.'
    );
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Raised for a value that cannot legally be put into a request body. */
export class XmlValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlValueError';
  }
}

/**
 * Decodes the XML entities the parser deliberately left alone.
 *
 * The parser runs with `processEntities: false`, so every text node arrives with
 * `&amp;`, `&lt;`, `&#13;` and friends still in it. They have to be decoded
 * somewhere, and this is the somewhere.
 *
 * The control-character guard is the load-bearing part and it is specific to
 * this protocol: `calendar-data` carries an iCalendar document, where CRLF is
 * what separates one property from the next. Decoding `&#13;&#10;` inside a
 * SUMMARY would therefore *create structure* —
 * `SUMMARY:harmless&#13;&#10;ATTENDEE;PARTSTAT=ACCEPTED:mailto:x` would become
 * two properties, one of which nobody wrote. A numeric reference to a C0/C1
 * character, a surrogate or an out-of-range code point is therefore emitted as
 * its literal source text instead of as a character: visible, inert, and
 * obviously wrong to a reader rather than silently effective.
 *
 * The one node this is *not* used on is `calendar-data`, whose content is a
 * document rather than a value — see {@link decodeCalendarData}.
 */
export function decodeXmlText(value: string): string {
  return decode(value, 'refuse');
}

/**
 * The same, for the one node whose content **is** a document.
 *
 * Two things happen here that happen nowhere else, and both come from the same
 * property of `calendar-data`: it is a `stopNodes` entry, so the parser hands
 * back its **raw source** rather than its text.
 *
 * **The packaging comes with it.** Raw source means the XML syntax that carried
 * the document is still in the string — see {@link unwrapDocumentNode}, which
 * takes it back off.
 *
 * **The entities come with it too**, and the rule for the two that matter is
 * the shape they arrive in rather than the code point. A server that encodes
 * its line endings emits the reference **immediately before the real newline it
 * stands for** — XML normalises a raw CR to LF on the way in, so escaping it is
 * the only way to keep it, and legitimate rather than suspicious. sabre/dav
 * does exactly that in the sibling protocol, where every card was unreadable
 * until the reader learned to tell this node apart from a value. A reference
 * smuggled into a *value* has no real newline behind it:
 * `SUMMARY:harmless&#13;&#10;ATTENDEE;PARTSTAT=ACCEPTED:mailto:x` stays literal
 * and invents no second property. Same rule, same words, in carddav-mcp — the
 * two servers used to disagree here, and both docblocks argued well for a rule
 * that cannot be right in only one of them, since iCalendar and vCard separate
 * their properties the same way.
 *
 * Everything else stays refused: other C0 characters, C1, surrogates and
 * out-of-range references are emitted as their literal source text.
 */
export function decodeCalendarData(value: string): string {
  return unwrapDocumentNode(value, (text) => decode(text, 'before-newline'));
}

/**
 * How a CR or LF reference is treated.
 *
 * - `refuse` — left as its literal source text. Every value outside the
 *   document node, where a decoded newline would end a line this server reads
 *   as one.
 * - `before-newline` — decoded only where a real newline follows it, the shape
 *   a server produces when it encodes its line endings. The document node, and
 *   nothing else.
 *
 * There is deliberately no third setting for "decode them wherever they are".
 * A server that encoded *both* halves of every line ending would leave no real
 * newline for the reference to sit in front of, and such a document would come
 * back as one unreadable line — but no server is known to do that, and the
 * relaxation that would cover it is exactly the one the smuggled-property test
 * exists to refuse. If a listing is ever empty against a server whose payload
 * is full of `&#13;&#10;`, this is the decision to revisit, with a test for
 * that server rather than a general loosening.
 */
type LineEndingPolicy = 'refuse' | 'before-newline';

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/**
 * Takes the XML packaging back off the raw source of a `stopNodes` node.
 *
 * `stopNodes` means "do not interpret this as markup", which is right — an
 * event description containing a `<` is a description, not an element. What it
 * does not mean is "extract the text": the parser hands back the source between
 * the tags verbatim, and everything XML allows as packaging comes along.
 * Open-Xchange (mailbox.org) wraps the payload in `<![CDATA[…]]>` in the
 * sibling protocol, where it meant an address book of 79 cards listing as
 * empty. This server has not been seen to meet it in `calendar-data` — the same
 * account serves that one unwrapped — but the node has the same shape and the
 * same reader, and a dialect nobody has met yet is exactly what this cost the
 * other server.
 *
 * Splitting rather than stripping, because a CDATA section is not just
 * punctuation: **inside it, `&amp;` is five characters, not one.** A
 * DESCRIPTION pasted out of an HTML editor says `&amp;` and means it. So the
 * decoder runs on the segments *outside* the sections only, and what is inside
 * is taken as it stands.
 *
 * More than one section is ordinary, not exotic: `]]>` cannot appear inside
 * CDATA, so a server splits a document containing that sequence into
 * `…a]]]]><![CDATA[>b…` and expects the reader to join it back up.
 *
 * The `trim` belongs to the same idea. `trimValues: true` never reaches a stop
 * node (measured), so a server that indents its response hands over
 * `\n        BEGIN:VCALENDAR…`, which fails to parse exactly as loudly and
 * exactly as silently. Leading whitespace before `BEGIN:` is packaging too.
 *
 * **Not covered: XML comments.** They also survive into the raw source
 * (measured), and no CalDAV server is known to write one inside
 * `calendar-data`. If a listing is ever empty against a server this function
 * already unwraps, that is the next thing to look at.
 */
function unwrapDocumentNode(
  value: string,
  decodeText: (text: string) => string
): string {
  let result = '';
  let index = 0;
  for (;;) {
    // `indexOf`, never a pattern: this runs on a document a server chose the
    // length of, and `test/linear-time.test.ts` holds the ceiling.
    const start = value.indexOf(CDATA_OPEN, index);
    if (start === -1) {
      result += decodeText(value.slice(index));
      break;
    }
    result += decodeText(value.slice(index, start));
    const body = start + CDATA_OPEN.length;
    const end = value.indexOf(CDATA_CLOSE, body);
    if (end === -1) {
      // Unterminated. The parser rejects the document before this point
      // (measured), so this is the second belt: take the rest as it stands
      // rather than decode something that announced itself as literal.
      result += value.slice(body);
      break;
    }
    result += value.slice(body, end);
    index = end + CDATA_CLOSE.length;
  }
  return result.trim();
}

function decode(value: string, lineEndings: LineEndingPolicy): string {
  return value.replace(
    /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#[xX]([0-9a-fA-F]+));/g,
    (
      source: string,
      named: string | undefined,
      dec: string | undefined,
      hex: string | undefined,
      offset: number,
      full: string
    ) => {
      if (named !== undefined) {
        return (
          { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named] ?? source
        );
      }
      const code = Number.parseInt(
        dec ?? hex ?? '',
        dec !== undefined ? 10 : 16
      );
      if (!Number.isFinite(code)) return source;
      if (code > 0x10ffff) return source;
      // Surrogates are not characters; a reference to one is malformed.
      if (code >= 0xd800 && code <= 0xdfff) return source;
      if (code === 0x0a || code === 0x0d) {
        if (
          lineEndings === 'before-newline' &&
          full.charCodeAt(offset + source.length) === 0x0a
        ) {
          return String.fromCodePoint(code);
        }
        return source;
      }
      // C0 and C1, tab excepted. This is the injection guard described above.
      if (code < 0x20 && code !== 0x09) return source;
      if (code >= 0x7f && code <= 0x9f) return source;
      return String.fromCodePoint(code);
    }
  );
}

/**
 * Refuses any document that declares a DTD or entities.
 *
 * The parser below does not process entities, so there is no local expansion
 * exposure. This guard exists so that can never silently change with a parser
 * update, and because a legitimate CalDAV response simply never contains one.
 */
export function assertNoDoctype(xml: string, what: string): void {
  if (/<!(doctype|entity)\b/i.test(xml)) {
    throw new Error(
      `${what} returned XML containing a DOCTYPE or ENTITY declaration, ` +
        'which this server refuses to parse.'
    );
  }
}

/**
 * The parser, deliberately dumb.
 *
 * `removeNSPrefix` is the one option worth arguing about. Radicale answers with
 * a default namespace for DAV and a prefix for CalDAV
 * (`<multistatus xmlns="DAV:" xmlns:C="…">`), sabre/dav prefixes both in
 * lowercase (`<d:multistatus xmlns:cal="…">`), and a third server may prefix
 * both in uppercase. Writing prefix-agnostic accessors by hand means checking
 * three spellings at every access, forever. Collapsing them costs the ability to
 * tell two namespaces apart when they share a local name — and across the
 * property set above there is no such pair.
 *
 * What keeps that safe is a rule rather than a check: **no security decision is
 * ever taken from a collapsed XML name.** The calendar allowlist is keyed on the
 * resolved collection *path*, never on anything this parser produced by name.
 *
 * `parseTagValue: false` because an ETag of `"00123"` must stay a string, and
 * `stopNodes` because `calendar-data` is a document in its own right that has no
 * business being interpreted as markup.
 *
 * The price of that last one is worth naming: a stop node is handed back as
 * **source**, not as text, so the parser's own conveniences skip it. Entities
 * arrive undecoded, CDATA sections arrive with their markers, and
 * `trimValues: true` does not reach it. {@link unwrapDocumentNode} is where
 * that is paid off.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
  trimValues: true,
  isArray: (name) =>
    ['response', 'propstat', 'href', 'comp', 'privilege'].includes(name),
  stopNodes: ['*.calendar-data'],
});

/** One `<D:response>` of a multistatus, reduced to what this server reads. */
export interface DavResponse {
  /** The response's own href, exactly as the server spelled it. */
  href: string;
  /** Properties from 2xx propstat blocks only. */
  props: Record<string, unknown>;
  /** The per-resource status, where the server sent one instead of propstats. */
  status?: string | undefined;
}

/**
 * Parses a `207 Multi-Status` document.
 *
 * Properties are taken from 2xx propstat blocks **only**. That is not tidiness:
 * a server answers a PROPFIND for a property the resource does not have with a
 * second propstat block carrying `404 Not Found` and the property name as an
 * empty element. Reading properties out of both blocks would turn "this calendar
 * has no colour" into "this calendar's colour is the empty string" — verified
 * against Radicale 3.8.0.0, which answers every PROPFIND with exactly this
 * two-block shape.
 */
export function parseMultiStatus(xml: string, what: string): DavResponse[] {
  assertNoDoctype(xml, what);
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error(`${what} did not return parseable XML.`);
  }
  const multistatus = doc.multistatus as { response?: unknown[] } | undefined;
  if (multistatus === undefined) {
    throw new Error(
      `${what} did not return a DAV multistatus document. ` +
        'CALDAV_URL is probably not a CalDAV endpoint.'
    );
  }
  const responses = Array.isArray(multistatus.response)
    ? multistatus.response
    : [];
  return responses.map((raw) => {
    const entry = raw as {
      href?: unknown[];
      propstat?: unknown[];
      status?: unknown;
    };
    const href = decodeXmlText(String(firstOf(entry.href) ?? ''));
    const props: Record<string, unknown> = {};
    for (const rawStat of entry.propstat ?? []) {
      const stat = rawStat as { prop?: unknown; status?: unknown };
      if (!isOkStatus(String(stat.status ?? ''))) continue;
      Object.assign(props, (stat.prop ?? {}) as Record<string, unknown>);
    }
    // `calendar-data` is a stop node, so it arrives as raw source with its
    // entities intact, and it is the one property read straight out of `props`
    // instead of through `textOf` — which is where every other value is
    // decoded. So an event called `Tom & Jerry` reached the model as
    // `Tom &amp; Jerry`, and ical.js parsed the escaped form into the summary.
    //
    // Through `decodeCalendarData` rather than `decodeXmlText`: this is the one
    // node whose content is a document in its own right, so it needs the two
    // things the parser skips for a stop node — its packaging taken off (CDATA
    // markers, indentation) and its line endings read the way the server that
    // encoded them meant them. See the docblock there.
    if (typeof props['calendar-data'] === 'string') {
      props['calendar-data'] = decodeCalendarData(props['calendar-data']);
    }
    return {
      href,
      props,
      status: entry.status === undefined ? undefined : String(entry.status),
    };
  });
}

/** `HTTP/1.1 200 OK` → true; `HTTP/1.1 404 Not Found` → false. */
function isOkStatus(status: string): boolean {
  const match = /\s(\d{3})\s/.exec(` ${status} `);
  if (match?.[1] === undefined) return false;
  const code = Number(match[1]);
  return code >= 200 && code < 300;
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads the hrefs out of a property whose value is one or more `<D:href>`.
 *
 * `current-user-principal`, `calendar-home-set` and `calendar-user-address-set`
 * all have this shape, and all three may legally carry several.
 */
export function hrefsOf(prop: unknown): string[] {
  if (prop === undefined || prop === null) return [];
  const href = (prop as { href?: unknown }).href;
  const list = Array.isArray(href) ? href : href === undefined ? [] : [href];
  return list
    .map((entry) => decodeXmlText(String(entry)).trim())
    .filter((entry) => entry.length > 0);
}

/** Whether a `resourcetype` value contains a given element, e.g. `calendar`. */
export function resourceTypeHas(prop: unknown, name: string): boolean {
  if (prop === undefined || prop === null || typeof prop !== 'object') {
    return false;
  }
  return Object.hasOwn(prop as Record<string, unknown>, name);
}

/**
 * The component names in a `supported-calendar-component-set`.
 *
 * Absent means "the server did not say", which per RFC 4791 means every
 * component is allowed — not that none is. The caller distinguishes the two by
 * getting an empty array here and treating it as unrestricted.
 */
export function supportedComponents(prop: unknown): string[] {
  if (prop === undefined || prop === null || typeof prop !== 'object')
    return [];
  const comps = (prop as { comp?: unknown }).comp;
  const list = Array.isArray(comps)
    ? comps
    : comps === undefined
      ? []
      : [comps];
  return list
    .map((entry) => String((entry as Record<string, unknown>)['@_name'] ?? ''))
    .filter((name) => name.length > 0)
    .map((name) => name.toUpperCase());
}

/** The privilege element names in a `current-user-privilege-set`. */
export function privileges(prop: unknown): string[] {
  if (prop === undefined || prop === null || typeof prop !== 'object')
    return [];
  const list = (prop as { privilege?: unknown }).privilege;
  const entries = Array.isArray(list) ? list : list === undefined ? [] : [list];
  return entries.flatMap((entry) =>
    entry !== null && typeof entry === 'object'
      ? Object.keys(entry as Record<string, unknown>)
      : []
  );
}

/**
 * Reads a plain text property, decoding entities.
 *
 * An element the server sent as empty (`<D:displayname />`) parses to an empty
 * string or an empty object depending on the shape; both mean absent here.
 */
export function textOf(prop: unknown): string | undefined {
  if (prop === undefined || prop === null) return undefined;
  if (typeof prop === 'object') return undefined;
  const text = decodeXmlText(String(prop)).trim();
  return text.length > 0 ? text : undefined;
}

// ---------------------------------------------------------------------------
// Request bodies
//
// Hand-built template strings rather than an XML builder, and that is a choice
// with reasons: the set of bodies is closed and small, the exact bytes are worth
// asserting against a captured request, and a builder would be a second code
// path that has to be proven never to emit a DOCTYPE and never to encode a value
// differently from the escaper above. The usual objection to string-built XML —
// injection — is answered by the variable surface being almost empty: property
// names come from a closed union, timestamps are re-serialised from a parsed
// value and match /^\d{8}T\d{6}Z$/ by construction, and hrefs are origin-checked
// outputs of `resolveHref`. Exactly one free-form value exists, and it is
// escaped.
// ---------------------------------------------------------------------------

const DECL = '<?xml version="1.0" encoding="utf-8"?>';

/** A PROPFIND asking for the named properties and nothing else. */
export function propfindBody(props: readonly PropName[]): string {
  const elements = props.map((name) => `    <${name}/>`).join('\n');
  return `${DECL}
<D:propfind ${NS}>
  <D:prop>
${elements}
  </D:prop>
</D:propfind>
`;
}

/** UTC timestamps as CalDAV wants them in a time-range filter. */
export interface TimeRange {
  /** `YYYYMMDDTHHMMSSZ`. */
  start: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  end: string;
}

const UTC_STAMP = /^\d{8}T\d{6}Z$/;

function assertStamp(value: string): string {
  if (!UTC_STAMP.test(value)) {
    throw new XmlValueError(
      `internal: "${value}" is not a UTC iCalendar timestamp. This is a bug.`
    );
  }
  return value;
}

/** iCalendar component names this server queries for. */
export type ComponentName = 'VEVENT' | 'VTODO' | 'VJOURNAL';

/**
 * A `calendar-query` REPORT over a component and a time window.
 *
 * The `calendar-data` is requested **whole**, never trimmed with a nested
 * `<C:comp>`/`<C:prop>` selection. RFC 4791 allows the trim and it would shrink
 * a listing considerably — but trimmed data must then be kept away from the
 * write path forever, and the day it leaks there it silently drops somebody's
 * alarms. Where the answer is too big the honest response is "narrow the
 * window", which is both true and actionable.
 */
export function calendarQueryBody(
  component: ComponentName,
  range?: TimeRange
): string {
  const filter =
    range === undefined
      ? ''
      : `\n        <C:time-range start="${assertStamp(range.start)}" end="${assertStamp(range.end)}"/>`;
  return `${DECL}
<C:calendar-query ${NS}>
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="${component}">${filter}
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>
`;
}

/** The iCalendar properties `search_events` will match a term against. */
export type SearchField = 'SUMMARY' | 'DESCRIPTION' | 'LOCATION' | 'CATEGORIES';

/**
 * A `calendar-query` REPORT matching a term against one property.
 *
 * One property per request, because RFC 4791 combines sibling `prop-filter`
 * elements with AND, not OR — a single body asking for SUMMARY *and*
 * DESCRIPTION matches only entries where the term appears in both. The caller
 * issues one request per field and unions the results by href.
 *
 * No `collation` attribute: omitting it takes the server's default, which both
 * Radicale and sabre/dav answer case-insensitively. Where a server refuses the
 * default with a `supported-collation` precondition, the caller retries once
 * with `i;ascii-casemap` and says so in the result.
 */
export function textMatchBody(
  component: ComponentName,
  field: SearchField,
  term: string,
  options: { collation?: string; range?: TimeRange } = {}
): string {
  const collation =
    options.collation === undefined
      ? ''
      : ` collation="${escapeXmlText(options.collation)}"`;
  const range =
    options.range === undefined
      ? ''
      : `\n        <C:time-range start="${assertStamp(options.range.start)}" end="${assertStamp(options.range.end)}"/>`;
  return `${DECL}
<C:calendar-query ${NS}>
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="${component}">${range}
        <C:prop-filter name="${field}">
          <C:text-match${collation}>${escapeXmlText(term)}</C:text-match>
        </C:prop-filter>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>
`;
}

/** A `free-busy-query` REPORT. Answers 200 `text/calendar`, not 207. */
export function freeBusyQueryBody(range: TimeRange): string {
  return `${DECL}
<C:free-busy-query ${NS}>
  <C:time-range start="${assertStamp(range.start)}" end="${assertStamp(range.end)}"/>
</C:free-busy-query>
`;
}

/** Largest body {@link parseDavError} will look at. */
export const MAX_ERROR_DOCUMENT_CHARS = 64 * 1024;

/**
 * Reads a DAV error document, which is more useful than a generic error body.
 *
 * sabre/dav puts a human-readable sentence in `<s:message>`, and both servers
 * name a failed precondition as an element inside `<D:error>`
 * (`<C:no-uid-conflict/>`, `<D:need-privileges/>`). Returning the precondition
 * name lets the caller say what actually went wrong instead of quoting a status
 * code back at the reader.
 */
export function parseDavError(
  xml: string
): { precondition?: string; message?: string } | undefined {
  // A real DAV error document is a few hundred bytes. Anything larger is not
  // one, and it is the body a hostile server controls most completely — so
  // the size is checked before a byte of it is parsed, and the DOCTYPE lock
  // holds here exactly as it does on a multistatus. Not throwing: the caller
  // is already building an error, and "no precondition found" is the right
  // answer to a document that is not a precondition.
  if (xml.length > MAX_ERROR_DOCUMENT_CHARS) return undefined;
  if (!/<[a-z0-9]*:?error[\s>]/i.test(xml)) return undefined;
  try {
    assertNoDoctype(xml, 'the error document');
  } catch {
    return undefined;
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const error = doc.error;
  if (error === undefined || error === null || typeof error !== 'object') {
    return undefined;
  }
  const entries = error as Record<string, unknown>;
  const message = textOf(entries.message);
  const precondition = Object.keys(entries).find(
    (key) => key !== 'message' && !key.startsWith('@_') && key !== '#text'
  );
  if (precondition === undefined && message === undefined) return undefined;
  return {
    ...(precondition === undefined ? {} : { precondition }),
    ...(message === undefined ? {} : { message }),
  };
}
