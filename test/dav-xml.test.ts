import { describe, expect, it } from 'vitest';

import {
  assertNoDoctype,
  calendarQueryBody,
  decodeCalendarData,
  decodeXmlText,
  escapeXmlText,
  freeBusyQueryBody,
  hrefsOf,
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

/** A multistatus around the given responses, both namespaces declared. */
const wrap = (inner: string): string =>
  `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${inner}</multistatus>`;

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
        privileges(first?.props['current-user-privilege-set']).toSorted(),
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

  it('refuses a DOCTYPE inside CDATA as well, which is the documented trade', () => {
    // The lock scans the raw text, so a literal `<!DOCTYPE` anywhere — even
    // inside a CDATA section a non-conforming server might use — fails the
    // document. A conforming server escapes text, and the escaped form
    // parses; this pins the fail-closed side so it is a decision, not a
    // surprise.
    expect(() =>
      parseMultiStatus(
        '<multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop>' +
          '<displayname><![CDATA[<!DOCTYPE html>]]></displayname></prop>' +
          '<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
        'a probe'
      )
    ).toThrow(/DOCTYPE or ENTITY/);
    const escaped = parseMultiStatus(
      '<multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop>' +
        '<displayname>&lt;!DOCTYPE html&gt;</displayname></prop>' +
        '<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
      'a probe'
    );
    // Raw here — entities are decoded by `textOf` at the reader — so the
    // literal `<!` never exists in the document the lock scans.
    expect(escaped[0]?.props.displayname).toBe('&lt;!DOCTYPE html&gt;');
  });

  it('leaves Object.prototype alone after a hostile document', () => {
    // fast-xml-parser refuses `__proto__`, `constructor` and `prototype` as
    // tag names, and `Object.assign` of the parsed props relies on that. The
    // dependency's guarantee, pinned here so a parser swap has to keep it.
    const hostile =
      '<multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop>' +
      '<__proto__><polluted>yes</polluted></__proto__>' +
      '<constructor><prototype><polluted>yes</polluted></prototype></constructor>' +
      '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
    try {
      parseMultiStatus(hostile, 'a probe');
    } catch {
      // Refusing the document is one acceptable answer.
    }
    expect(
      (Object.getPrototypeOf({}) as Record<string, unknown>).polluted
    ).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses the hostile names outright and renames the awkward ones', () => {
    // The parser's own behaviour, pinned by name: `__proto__`, `constructor`
    // and `prototype` as element names throw (with or without a prefix),
    // and `hasOwnProperty` is renamed so it cannot shadow the method on the
    // props object that `resourceTypeHas` calls.
    for (const name of [
      '__proto__',
      'constructor',
      'prototype',
      'D:__proto__',
      'D:constructor',
    ]) {
      const doc =
        '<multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop>' +
        `<${name}><polluted>yes</polluted></${name}>` +
        '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
      expect(() => parseMultiStatus(doc, 'a probe'), name).toThrow(
        /parseable XML/
      );
    }
    const renamed =
      '<multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop>' +
      '<resourcetype><hasOwnProperty/><toString/></resourcetype>' +
      '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
    const [first] = parseMultiStatus(renamed, 'a probe');
    expect(resourceTypeHas(first?.props.resourcetype, 'hasOwnProperty')).toBe(
      false
    );
    expect(resourceTypeHas(first?.props.resourcetype, 'toString')).toBe(false);
    expect(resourceTypeHas(first?.props.resourcetype, 'calendar')).toBe(false);
  });

  it('reads the malformed shapes a server can send without throwing', () => {
    // No responses at all.
    expect(parseMultiStatus(wrap(''), 'a probe')).toEqual([]);
    // A propstat whose status carries no three-digit code drops its props;
    // a bare code is read, since the digits are what the check is about.
    for (const status of ['HTTP/1.1 abc', '', 'OK 200OK', 'HTTP/1.1 2000 X']) {
      const [first] = parseMultiStatus(
        wrap(
          `<response><href>/x</href><propstat><prop><displayname>X</displayname>` +
            `</prop><status>${status}</status></propstat></response>`
        ),
        'a probe'
      );
      expect(first?.props.displayname, JSON.stringify(status)).toBeUndefined();
    }
    // A single comp or privilege element rather than a list.
    const [single] = parseMultiStatus(
      wrap(
        '<response><href>/x</href><propstat><prop>' +
          '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' +
          '<current-user-privilege-set><privilege><read/></privilege></current-user-privilege-set>' +
          '<C:calendar-home-set><href>/h/</href></C:calendar-home-set>' +
          '</prop><status>HTTP/1.1 200 OK</status></propstat></response>'
      ),
      'a probe'
    );
    expect(
      supportedComponents(single?.props['supported-calendar-component-set'])
    ).toEqual(['VEVENT']);
    expect(privileges(single?.props['current-user-privilege-set'])).toEqual([
      'read',
    ]);
    expect(hrefsOf(single?.props['calendar-home-set'])).toEqual(['/h/']);
    // The accessors on nothing, text and a number.
    for (const value of [undefined, null, 'text', 42, [], {}]) {
      expect(hrefsOf(value)).toEqual([]);
      expect(supportedComponents(value)).toEqual([]);
      expect(privileges(value)).toEqual([]);
      expect(resourceTypeHas(value, 'calendar')).toBe(false);
    }
    expect(textOf({})).toBeUndefined();
    expect(textOf('  ')).toBeUndefined();
    expect(textOf(42)).toBe('42');
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

function dataOf(ics: string): string {
  const xml =
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" ` +
    `xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response>` +
    `<D:href>/tester/work/a.ics</D:href><D:propstat>` +
    `<D:status>HTTP/1.1 200 OK</D:status><D:prop>` +
    `<C:calendar-data>${ics}</C:calendar-data>` +
    `</D:prop></D:propstat></D:response></D:multistatus>`;
  return String(parseMultiStatus(xml, 'test')[0]?.props['calendar-data']);
}

describe('the iCalendar document inside a multistatus', () => {
  it('decodes the entities the parser was told to leave alone', () => {
    // `calendar-data` is a stop node and the one property read straight out of
    // `props` rather than through `textOf`, so it used to skip decoding
    // entirely: an event called `Tom & Jerry` arrived as `Tom &amp; Jerry` and
    // ical.js put the escaped form in the summary.
    expect(dataOf('SUMMARY:Tom &amp; Jerry &lt;3&gt;')).toBe(
      'SUMMARY:Tom & Jerry <3>'
    );
  });

  it('will not let an entity invent a second property', () => {
    // The reason the decoder refuses control characters, on the document it
    // was written for. CRLF is what separates one iCalendar property from the
    // next, so a decoded `&#13;&#10;` inside a SUMMARY would end that property
    // and start an ATTENDEE line nobody wrote — an RSVP forged by a string.
    const forged = dataOf(
      'SUMMARY:harmless&#13;&#10;ATTENDEE;PARTSTAT=ACCEPTED:mailto:x@y.z'
    );
    expect(forged).toContain('&#13;&#10;');
    expect(forged.split(/\r?\n/)).toHaveLength(1);
  });

  it('leaves a hex reference to a control character alone too', () => {
    expect(dataOf('SUMMARY:a&#x0D;&#x0A;b')).toBe('SUMMARY:a&#x0D;&#x0A;b');
  });
});

describe('the line endings a server encodes', () => {
  it('decodes a reference that a real newline follows', () => {
    // What a server writes when it encodes a line ending: XML normalises a raw
    // CR to LF on the way in, so escaping it is the only way to keep it. This
    // is sabre/dav's shape, and refusing it made every card in the sibling
    // server unreadable against Baikal.
    const encoded = 'BEGIN:VCALENDAR&#13;\nSUMMARY:a&#13;\nEND:VCALENDAR';
    expect(decodeCalendarData(encoded)).toBe(
      'BEGIN:VCALENDAR\r\nSUMMARY:a\r\nEND:VCALENDAR'
    );
  });

  it('refuses one that no real newline follows', () => {
    // The forged RSVP, unchanged in outcome from before this rule existed: the
    // reference sits inside a SUMMARY, with the document's own newlines raw
    // around it, and invents no second property.
    const forged =
      'BEGIN:VCALENDAR\nSUMMARY:harmless&#13;&#10;ATTENDEE;PARTSTAT=ACCEPTED:mailto:x@y.z\nEND:VCALENDAR';
    const decoded = decodeCalendarData(forged);
    expect(decoded).toContain('&#13;&#10;');
    expect(decoded.split('\n')).toHaveLength(3);
  });

  it('refuses both halves even where that leaves the document unreadable', () => {
    // The boundary, written down rather than left to be discovered. A server
    // that encoded both halves of every line ending would leave no real newline
    // for the reference to sit in front of. Loosening the rule to cover it is
    // exactly the loosening the test above refuses, and no such server is
    // known — so the choice is to keep the guard and fail visibly.
    expect(decodeCalendarData('BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR')).toBe(
      'BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR'
    );
  });

  it('still refuses every other control character', () => {
    expect(decodeCalendarData('a&#0;b')).toBe('a&#0;b');
    expect(decodeCalendarData('a&#x7f;b')).toBe('a&#x7f;b');
    expect(decodeCalendarData('a&#xD800;b')).toBe('a&#xD800;b');
  });

  it('is not what the other nodes get', () => {
    // A `displayname` is one line to this server, and there is no dialect that
    // needs a newline in one — so that node keeps the strict rule.
    expect(decodeXmlText('Work&#13;\nevil')).toBe('Work&#13;\nevil');
  });
});

describe('the packaging around a stop node', () => {
  it('unwraps a CDATA section', () => {
    // Open-Xchange wraps the payload this way in the sibling protocol, where it
    // meant an address book of 79 cards listing as empty. `stopNodes` hands
    // back source, so the markers were part of what went to the parser.
    expect(
      decodeCalendarData('<![CDATA[BEGIN:VCALENDAR\nEND:VCALENDAR]]>')
    ).toBe('BEGIN:VCALENDAR\nEND:VCALENDAR');
  });

  it('joins the sections a document containing "]]>" is split into', () => {
    // Not exotic: `]]>` cannot appear inside CDATA, so a server that meets one
    // ends the section and opens another, and expects the reader to join them.
    expect(
      decodeCalendarData('<![CDATA[DESCRIPTION:a]]]]><![CDATA[>b]]>')
    ).toBe('DESCRIPTION:a]]>b');
  });

  it('leaves an entity inside a section alone and decodes one outside', () => {
    // The reason this splits rather than strips. Inside CDATA `&amp;` is five
    // characters and the document means them; outside it is one.
    expect(
      decodeCalendarData(
        'SUMMARY:Tom &amp; Jerry\n<![CDATA[DESCRIPTION:a &amp; b]]>'
      )
    ).toBe('SUMMARY:Tom & Jerry\nDESCRIPTION:a &amp; b');
  });

  it('takes an indented response apart', () => {
    // `trimValues: true` never reaches a stop node, so a server that pretty
    // prints hands over leading whitespace — and `BEGIN:` has to be first.
    expect(
      decodeCalendarData('\n    <![CDATA[BEGIN:VCALENDAR\nEND:VCALENDAR]]>\n  ')
    ).toBe('BEGIN:VCALENDAR\nEND:VCALENDAR');
    expect(decodeCalendarData('\n  BEGIN:VCALENDAR\nEND:VCALENDAR\n  ')).toBe(
      'BEGIN:VCALENDAR\nEND:VCALENDAR'
    );
  });

  it('takes the rest as it stands when a section is never closed', () => {
    // The parser rejects such a document before this function sees it. This is
    // the second belt, and it does not decode what announced itself literal.
    expect(decodeCalendarData('<![CDATA[SUMMARY:a &amp; b')).toBe(
      'SUMMARY:a &amp; b'
    );
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

  it('answers nothing for an error element that is not an element', () => {
    for (const body of [
      '<?xml version="1.0"?><D:error xmlns:D="DAV:">just text</D:error>',
      '<?xml version="1.0"?><D:error xmlns:D="DAV:"/>',
      '<?xml version="1.0"?><D:error xmlns:D="DAV:"></D:error>',
      '<?xml version="1.0"?><root><D:error xmlns:D="DAV:">x</D:error><D:error xmlns:D="DAV:">y</D:error></root>',
      '<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:error',
    ]) {
      expect(parseDavError(body), body).toBeUndefined();
    }
    expect(
      parseDavError(
        '<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:need-privileges/></D:error>'
      )
    ).toEqual({ precondition: 'need-privileges' });
  });

  it('answers nothing for a body that is not one', () => {
    expect(parseDavError('just words')).toBeUndefined();
    expect(parseDavError('<html><body>oops</body></html>')).toBeUndefined();
  });

  it('holds the DOCTYPE lock on an error body too', () => {
    // The body a hostile server controls most completely is the one it sends
    // with a 4xx, and this used to be the one parse without the lock.
    expect(
      parseDavError(
        '<?xml version="1.0"?><!DOCTYPE error [<!ENTITY a "b">]>' +
          '<D:error xmlns:D="DAV:"><D:need-privileges/></D:error>'
      )
    ).toBeUndefined();
  });

  it('does not parse an error body larger than a real one could be', () => {
    const padding = '<x/>'.repeat(20_000);
    expect(
      parseDavError(
        `<D:error xmlns:D="DAV:"><D:need-privileges/>${padding}</D:error>`
      )
    ).toBeUndefined();
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

  it('builds a free-busy query', () => {
    expect(freeBusyQueryBody(RANGE)).toContain('<C:free-busy-query');
  });
});
