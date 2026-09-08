import { describe, expect, it } from 'vitest';

import {
  escapeInvisible,
  quoted,
  sanitizeText,
  stripInvisible,
} from '../src/analyze.js';
import { CalDavApi, CalDavApiError } from '../src/api.js';
import {
  normalisePath,
  resourceUrl,
  stripTrailingSlashes,
} from '../src/calendars.js';
import { decodeCalendarData, decodeXmlText } from '../src/dav-xml.js';
import { resourceNameOf } from '../src/entries.js';
import { parseEntityId } from '../src/entity-id.js';
import { redactUrlCredentials } from '../src/redact.js';
import { calendarId } from '../src/shape.js';
import { testConfig } from './harness.js';

/**
 * Every function that walks a string the server or the caller chose, timed at
 * the largest input it can receive — or past it, where the bound is the point.
 *
 * The shape that bites is a regex anchored at the end whose body can match a
 * long run: `/\/+$/`, `/[^/]*$/`. It is tried from every position of the run
 * and consumes the run each time, so eighty thousand slashes followed by one
 * other character cost two seconds, and a segment filling the 16 MiB
 * multistatus ceiling cost hours. Three of those were in code two audits had
 * read. This file is where the next one gets its line before it is merged.
 */

const N = 80_000;

/**
 * The band between the two answers, not a performance budget.
 *
 * Every case here is linear and lands in single-digit to low-hundred
 * milliseconds. The quadratic shapes this file exists for cost, measured on
 * this machine at the same input, 1794 ms (`/\/+$/` on 80k slashes) and
 * 2031 ms (`/[^/]*$/` on a long segment) — and hours at the multistatus
 * ceiling. A second sits between the two answers with room on both sides.
 *
 * It used to be 200 ms, which is inside the noise of a loaded shared runner:
 * the release run for 0.1.3 measured 212 ms for a case that takes 30 ms here,
 * and a red release on a busy machine says nothing about the code.
 */
const LIMIT_MS = 1_000;

/**
 * The fastest of three runs.
 *
 * Noise on a shared runner only ever adds time — a scheduler slice, a garbage
 * collection, a neighbour — so the minimum is the closest reading to what the
 * algorithm costs. A quadratic walk is slow in all three.
 */
function elapsed(fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    try {
      fn();
    } catch {
      // A refusal is a fine answer; the time is what is measured.
    }
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

const api = new CalDavApi(testConfig());
const WORK = {
  url: 'https://dav.example.net/tester/work/',
  path: '/tester/work/',
};

describe('every string walk is linear at its ceiling', () => {
  it.each([
    [
      'normalisePath, slashes then a character',
      () => normalisePath(`/a${'/'.repeat(N)}x`),
    ],
    [
      'normalisePath, one long segment',
      () => normalisePath(`/${'a'.repeat(N)}`),
    ],
    ['stripTrailingSlashes', () => stripTrailingSlashes(`${'/'.repeat(N)}x`)],
    ['resourceUrl, a long name', () => resourceUrl(WORK, 'a'.repeat(N))],
    [
      'resourceUrl, a name of slashes',
      () => resourceUrl(WORK, `${'/'.repeat(N)}x`),
    ],
    [
      'resourceNameOf, a long segment then a slash',
      () => resourceNameOf(`/tester/work/${'a'.repeat(N)}/`, api, WORK),
    ],
    [
      'resourceNameOf, slashes then a character',
      () => resourceNameOf(`/tester/work/${'/'.repeat(N)}x`, api, WORK),
    ],
    [
      'resolveHref, a long href',
      () => api.resolveHref(`/tester/${'a'.repeat(N)}`),
    ],
    [
      'an error message with a long unparseable URL',
      () => new CalDavApiError(500, '', 'GET', `/x?${'?'.repeat(N)}`),
    ],
    [
      'redactUrlCredentials, a long userinfo',
      () => redactUrlCredentials(`https://${'a'.repeat(N)}@h/`),
    ],
    [
      'redactUrlCredentials, many at signs',
      () => redactUrlCredentials(`https://${'@'.repeat(N)}/`),
    ],
    ['calendarId', () => calendarId(`/${'é'.repeat(N)}/`)],
    ['decodeXmlText, many ampersands', () => decodeXmlText('&'.repeat(N))],
    [
      'decodeXmlText, an unterminated reference',
      () => decodeXmlText(`&#${'9'.repeat(N)}`),
    ],
    [
      'decodeCalendarData, a document made of CDATA openings',
      () => decodeCalendarData('<![CDATA['.repeat(N / 9)),
    ],
    [
      'decodeCalendarData, many closed sections',
      () => decodeCalendarData('<![CDATA[a]]>'.repeat(N / 13)),
    ],
    ['stripInvisible', () => stripInvisible('​'.repeat(N))],
    ['escapeInvisible', () => escapeInvisible('‮'.repeat(N))],
    ['quoted, whitespace', () => quoted(' '.repeat(N))],
    ['sanitizeText, image syntax', () => sanitizeText(`![${'a'.repeat(N)}`)],
    ['sanitizeText, brackets', () => sanitizeText('!['.repeat(N / 2))],
    [
      'parseEntityId, a long part',
      () =>
        parseEntityId(`e1.${'A'.repeat(N)}.${'B'.repeat(N)}`, 'vevent', {
          allows: () => true,
          knows: () => true,
        }),
    ],
  ])('%s', (_label, fn) => {
    expect(elapsed(fn)).toBeLessThan(LIMIT_MS);
  });
});

describe('what the ceilings refuse', () => {
  it('refuses an href longer than any real one', () => {
    expect(() => api.resolveHref(`/${'a'.repeat(8 * 1024 + 1)}`)).toThrow(
      /longer than any link/
    );
    expect(api.resolveHref(`/${'a'.repeat(8 * 1024 - 1)}`)).toContain('/aaaa');
  });
});
