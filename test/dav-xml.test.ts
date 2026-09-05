import { describe, expect, it } from 'vitest';

import {
  assertNoDoctype,
  calendarQueryBody,
  decodeXmlText,
  escapeXmlText,
  freeBusyQueryBody,
  hrefsOf,
  multigetBody,
  parseDavError,
  parseMultiStatus,
  privileges,
  propfindBody,
  resourceTypeHas,
  supportedComponents,
  textMatchBody,
  textOf,
  XmlValueError,
} from '../src/dav-xml.js';

/**
 * The XML layer, which is where the only genuinely free-form value this server
 * puts on the wire lives — and where the one decoding step that can *create*
 * structure out of somebody else's text happens.
 */

const RANGE = { start: '20260901T000000Z', end: '20261001T000000Z' };

describe('escaping a value for a request body', () => {
  it('escapes the five built-ins', () => {
    expect(escapeXmlText(`a & b < c > d " e ' f`)).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f'
    );
  });

  it('refuses control characters instead of encoding them', () => {
    // CR and LF are refused with the rest, and that is the point: a line break
    // is meaningless in a search term and structural in iCalendar.
    for (const bad of ['a\u0000b', 'a\nb', 'a\rb', 'a\u0007b', 'a\u009fb']) {
      expect(() => escapeXmlText(bad)).toThrow(XmlValueError);
    }
    // Tab is legal text and survives.
    expect(escapeXmlText('a\tb')).toBe('a\tb');
  });

  it('refuses an unpaired surrogate', () => {
    expect(() => escapeXmlText('a\uD800b')).toThrow(/unpaired surrogate/);
    expect(escapeXmlText('a😀b')).toBe('a😀b');
  });

  it('cannot be escaped out of a text-match element', () => {
    // The attack this exists for: closing the element and opening another.
    const body = textMatchBody(
      'VEVENT',
      'SUMMARY',
      ']]></C:text-match><C:prop-filter name="X">'
    );
    expect(body).not.toContain('</C:text-match><C:prop-filter name="X">');
    expect(body).toContain('&lt;/C:text-match&gt;');
    // And exactly one real text-match element survives.
    expect((body.match(/<C:text-match/g) ?? []).length).toBe(1);
  });
});

describe('decoding a value out of a response', () => {
  it('decodes the five built-ins', () => {
    expect(decodeXmlText('a &amp; b &lt; c &gt; d &quot; e &apos;')).toBe(
      `a & b < c > d " e '`
    );
  });

  it('decodes ordinary numeric references', () => {
    expect(decodeXmlText('caf&#233;')).toBe('café');
    expect(decodeXmlText('caf&#xE9;')).toBe('café');
  });

  it('refuses to turn a numeric reference into an iCalendar line break', () => {
    // The one that matters. calendar-data carries an iCalendar document, where
    // CRLF separates one property from the next — so decoding this would create
    // an ATTENDEE line nobody wrote.
    const payload =
      'SUMMARY:harmless&#13;&#10;ATTENDEE;PARTSTAT=ACCEPTED:mailto:evil@example.net';
    const decoded = decodeXmlText(payload);
    expect(decoded).not.toContain('\r');
    expect(decoded).not.toContain('\n');
    expect(decoded).toContain('&#13;&#10;');
    expect(decoded.split(/\r?\n/)).toHaveLength(1);
  });

  it('leaves a surrogate or an out-of-range reference as source text', () => {
    expect(decodeXmlText('a&#xD800;b')).toBe('a&#xD800;b');
    expect(decodeXmlText('a&#x110000;b')).toBe('a&#x110000;b');
    expect(decodeXmlText('a&#127;b')).toBe('a&#127;b');
  });

  it('leaves an unknown entity alone', () => {
    expect(decodeXmlText('a&nbsp;b')).toBe('a&nbsp;b');
  });
});

describe('refusing a document with a DTD', () => {
  it('throws for a DOCTYPE or an ENTITY declaration', () => {
    expect(() => assertNoDoctype('<!DOCTYPE x []><x/>', 'a probe')).toThrow(
      /DOCTYPE or ENTITY/
    );
    expect(() => assertNoDoctype('<!ENTITY a "b">', 'a probe')).toThrow();
    expect(() => assertNoDoctype('<x/>', 'a probe')).not.toThrow();
  });
});

describe('parsing a multistatus', () => {
  /** Radicale: default namespace for DAV, a prefix for CalDAV. */
  const radicale = `<?xml version='1.0' encoding='utf-8'?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <response>
    <href>/tester/work/</href>
    <propstat><prop>
      <resourcetype><C:calendar /><collection /></resourcetype>
      <displayname>Work</displayname>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>
      <current-user-privilege-set><privilege><read /></privilege><privilege><write /></privilege></current-user-privilege-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
    <propstat><prop><CS:getctag /></prop><status>HTTP/1.1 404 Not Found</status></propstat>
  </response>
</multistatus>`;

  /** sabre/dav: lowercase prefixes for both. */
  const sabre = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/dav.php/calendars/tester/work/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><cal:calendar /><d:collection /></d:resourcetype>
      <d:displayname>Work</d:displayname>
      <cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
      <d:current-user-privilege-set><d:privilege><d:read /></d:privilege><d:privilege><d:write /></d:privilege></d:current-user-privilege-set>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    <d:propstat><d:prop><cs:getctag /></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

  it('reads both prefix shapes identically', () => {
    // The reason `removeNSPrefix` is on: writing prefix-agnostic accessors by
    // hand means checking three spellings at every access, forever.
    for (const [label, document] of [
      ['radicale', radicale],
      ['sabre', sabre],
    ] as const) {
      const [first] = parseMultiStatus(document, label);
      expect(first, label).toBeDefined();
      expect(
        resourceTypeHas(first?.props.resourcetype, 'calendar'),
        label
      ).toBe(true);
      expect(textOf(first?.props.displayname), label).toBe('Work');
      expect(
        supportedComponents(first?.props['supported-calendar-component-set']),
        label
      ).toEqual(['VEVENT', 'VTODO']);
      expect(
        privileges(first?.props['current-user-privilege-set']).sort(),
        label
      ).toEqual(['read', 'write']);
    }
  });

  it('takes properties only from 2xx propstat blocks', () => {
    // Radicale answers every PROPFIND with two blocks, one of them 404 with the
    // absent properties as empty elements. Reading both would turn "this
    // calendar has no ctag" into "its ctag is the empty string".
    const [first] = parseMultiStatus(radicale, 'radicale');
    expect(first?.props.getctag).toBeUndefined();
  });

  it('refuses a document that is not a multistatus', () => {
    expect(() => parseMultiStatus('<html><body/></html>', 'a probe')).toThrow(
      /not return a DAV multistatus/
    );
  });

  it('refuses a document carrying a DOCTYPE', () => {
    expect(() =>
      parseMultiStatus('<!DOCTYPE x><multistatus xmlns="DAV:"/>', 'a probe')
    ).toThrow(/DOCTYPE or ENTITY/);
  });

  it('reads several hrefs out of one property', () => {
    const document = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response><href>/p/</href><propstat><prop>
    <C:calendar-home-set><href>/a/</href><href>/b/</href></C:calendar-home-set>
  </prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const [first] = parseMultiStatus(document, 'a probe');
    expect(hrefsOf(first?.props['calendar-home-set'])).toEqual(['/a/', '/b/']);
  });

  it('decodes entities in an href', () => {
    const document = `<?xml version="1.0"?>
<multistatus xmlns="DAV:"><response><href>/a&amp;b/</href>
<propstat><prop><displayname>x</displayname></prop><status>HTTP/1.1 200 OK</status></propstat>
</response></multistatus>`;
    expect(parseMultiStatus(document, 'a probe')[0]?.href).toBe('/a&b/');
  });

  it('keeps calendar-data as a string rather than interpreting it', () => {
    const document = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response><href>/x.ics</href><propstat><prop>
    <getetag>"abc"</getetag>
    <C:calendar-data>BEGIN:VCALENDAR&#13;
SUMMARY:a &lt;b&gt; &amp; c&#13;
END:VCALENDAR</C:calendar-data>
  </prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;
    const [first] = parseMultiStatus(document, 'a probe');
    expect(typeof first?.props['calendar-data']).toBe('string');
    // An ETag of "00123" must not become a number, either.
    expect(first?.props.getetag).toBe('"abc"');
  });
});

describe('reading a DAV error document', () => {
  it('names the precondition and the message', () => {
    const document = `<?xml version="1.0"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <cal:supported-calendar-component/>
  <s:message>This calendar only supports VEVENT</s:message>
</d:error>`;
    expect(parseDavError(document)).toEqual({
      precondition: 'supported-calendar-component',
      message: 'This calendar only supports VEVENT',
    });
  });

  it('answers nothing for a body that is not one', () => {
    expect(parseDavError('just words')).toBeUndefined();
    expect(parseDavError('<html><body>oops</body></html>')).toBeUndefined();
  });
});

describe('the request bodies', () => {
  it('asks for exactly the properties it was given', () => {
    const body = propfindBody(['D:resourcetype', 'C:calendar-home-set']);
    expect(body).toContain('<D:resourcetype/>');
    expect(body).toContain('<C:calendar-home-set/>');
    expect(body).toContain('xmlns:D="DAV:"');
    expect(body).not.toContain('DOCTYPE');
  });

  it('builds a calendar-query with a time range', () => {
    const body = calendarQueryBody('VEVENT', RANGE);
    expect(body).toContain('<C:comp-filter name="VCALENDAR">');
    expect(body).toContain('<C:comp-filter name="VEVENT">');
    expect(body).toContain(
      '<C:time-range start="20260901T000000Z" end="20261001T000000Z"/>'
    );
    // Whole calendar-data, never a trimmed selection: trimmed data must then be
    // kept away from the write path forever, and the day it leaks there it
    // drops somebody's alarms.
    expect(body).toContain('<C:calendar-data/>');
    expect(body).not.toContain('<C:comp name=');
  });

  it('refuses a timestamp that is not the one form a body accepts', () => {
    expect(() =>
      calendarQueryBody('VEVENT', { start: '2026-09-01', end: RANGE.end })
    ).toThrow(XmlValueError);
  });

  it('builds one text-match per field, not several in one body', () => {
    // RFC 4791 combines sibling prop-filters with AND, so a single body asking
    // for SUMMARY and DESCRIPTION would match only entries carrying the term in
    // both.
    const body = textMatchBody('VEVENT', 'DESCRIPTION', 'standup');
    expect((body.match(/<C:prop-filter/g) ?? []).length).toBe(1);
    expect(body).toContain('<C:prop-filter name="DESCRIPTION">');
    expect(body).not.toContain('collation=');
  });

  it('names a collation only when asked to', () => {
    const body = textMatchBody('VEVENT', 'SUMMARY', 'x', {
      collation: 'i;ascii-casemap',
    });
    expect(body).toContain('collation="i;ascii-casemap"');
  });

  it('escapes an href in a multiget', () => {
    // An href is a URL and a URL may legally contain `&`.
    const body = multigetBody(['/work/a&b.ics']);
    expect(body).toContain('<D:href>/work/a&amp;b.ics</D:href>');
  });

  it('builds a free-busy query', () => {
    expect(freeBusyQueryBody(RANGE)).toContain('<C:free-busy-query');
  });
});
