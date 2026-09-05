import { describe, expect, it } from 'vitest';

import { CalendarNotAllowedError, ToolInputError } from '../src/errors.js';
import {
  buildOccurrenceId,
  buildSeriesId,
  isOccurrenceId,
  parseEntityId,
  seriesIdOf,
  type CalendarLookup,
} from '../src/entity-id.js';

/**
 * The addressing scheme, and the calendar allowlist that lives inside it.
 *
 * The registry is a *required argument* of the decoder, so there is no path
 * from an id to a URL that skips the check. These tests are what keep that
 * true, because it is a property of the signature rather than of any one
 * caller.
 */

const registry: CalendarLookup = {
  allows: (path) => path === '/tester/work/',
  knows: (path) => path === '/tester/work/' || path === '/tester/shared/',
};

const b64 = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');

describe('round trips', () => {
  it('encodes and decodes a series id', () => {
    const id = buildSeriesId('vevent', '/tester/work/', 'a1b2c3.ics');
    const parsed = parseEntityId(id, 'vevent', registry);
    expect(parsed).toEqual({
      kind: 'vevent',
      calendarPath: '/tester/work/',
      resourceName: 'a1b2c3.ics',
      recurrenceId: undefined,
    });
    expect(isOccurrenceId(parsed)).toBe(false);
  });

  it('encodes and decodes an occurrence id', () => {
    const id = buildOccurrenceId(
      'vevent',
      '/tester/work/',
      'a1b2c3.ics',
      'TZID=Europe/Berlin:20260907T090000'
    );
    const parsed = parseEntityId(id, 'vevent', registry);
    expect(parsed.recurrenceId).toBe('TZID=Europe/Berlin:20260907T090000');
    expect(isOccurrenceId(parsed)).toBe(true);
    expect(seriesIdOf(parsed)).toBe(
      buildSeriesId('vevent', '/tester/work/', 'a1b2c3.ics')
    );
  });

  it('uses a different tag per kind', () => {
    const paths = ['/tester/work/', 'x.ics'] as const;
    expect(buildSeriesId('vevent', ...paths).startsWith('e1.')).toBe(true);
    expect(buildSeriesId('vtodo', ...paths).startsWith('t1.')).toBe(true);
    expect(buildSeriesId('vjournal', ...paths).startsWith('j1.')).toBe(true);
  });

  it('survives a path with characters that need encoding', () => {
    const id = buildSeriesId('vevent', '/tester/work/', 'a%20b&c.ics');
    expect(parseEntityId(id, 'vevent', registry).resourceName).toBe(
      'a%20b&c.ics'
    );
  });
});

describe('the allowlist, enforced while decoding', () => {
  it('refuses a calendar outside it, and says which case it is', () => {
    const fenced = buildSeriesId('vevent', '/tester/shared/', 'x.ics');
    expect(() => parseEntityId(fenced, 'vevent', registry)).toThrow(
      CalendarNotAllowedError
    );
    // "Fenced off" and "does not exist" are different things to say: telling
    // them apart stops somebody hunting a typo in a name that is spelled right.
    expect(() => parseEntityId(fenced, 'vevent', registry)).toThrow(
      /not given access/
    );

    const unknown = buildSeriesId('vevent', '/tester/nowhere/', 'x.ics');
    expect(() => parseEntityId(unknown, 'vevent', registry)).toThrow(
      /cannot see/
    );
  });

  it('cannot be reached without a registry', () => {
    // Not a runtime assertion but a signature one: the third parameter is
    // required, so a tool cannot decode an id without performing the check.
    expect(parseEntityId.length).toBe(3);
  });
});

describe('a forged or edited id', () => {
  it('refuses a kind that does not match the tool', () => {
    const task = buildSeriesId('vtodo', '/tester/work/', 'x.ics');
    // Named rather than answered with "not found": an id that decodes perfectly
    // and belongs to a task is a different situation from one naming nothing.
    expect(() => parseEntityId(task, 'vevent', registry)).toThrow(
      /that is the id of a task/
    );
  });

  it('refuses a path with a dot segment', () => {
    const id = `e1.${b64('/tester/work/../shared/')}.${b64('x.ics')}`;
    expect(() => parseEntityId(id, 'vevent', registry)).toThrow(ToolInputError);
  });

  it('refuses a relative calendar path', () => {
    const id = `e1.${b64('tester/work/')}.${b64('x.ics')}`;
    expect(() => parseEntityId(id, 'vevent', registry)).toThrow(ToolInputError);
  });

  it('refuses a resource name that is more than one segment', () => {
    for (const name of ['../secret.ics', 'sub/x.ics', '.hidden', '']) {
      const id = `e1.${b64('/tester/work/')}.${b64(name)}`;
      expect(() => parseEntityId(id, 'vevent', registry), name).toThrow(
        ToolInputError
      );
    }
  });

  it('refuses a NUL inside a decoded part', () => {
    const id = `e1.${b64('/tester/work/\0/etc/')}.${b64('x.ics')}`;
    expect(() => parseEntityId(id, 'vevent', registry)).toThrow(ToolInputError);
  });

  it('refuses base64 that is not exactly the encoding of its value', () => {
    // `Buffer.from(…, 'base64url')` is lenient — it ignores characters outside
    // the alphabet — so two different ids could otherwise decode to one value.
    const valid = buildSeriesId('vevent', '/tester/work/', 'x.ics');
    const parts = valid.split('.');
    const padded = `${parts[0]}.${parts[1]}=.${parts[2]}`;
    expect(() => parseEntityId(padded, 'vevent', registry)).toThrow(
      ToolInputError
    );
  });

  it('refuses a wrong number of parts', () => {
    for (const id of ['e1', 'e1.abc', 'e1.a.b.c.d', '']) {
      expect(() => parseEntityId(id, 'vevent', registry), id).toThrow(
        ToolInputError
      );
    }
  });

  it('refuses an unknown kind tag', () => {
    const id = `z9.${b64('/tester/work/')}.${b64('x.ics')}`;
    expect(() => parseEntityId(id, 'vevent', registry)).toThrow(ToolInputError);
  });

  it('never carries an origin, so it cannot name another host', () => {
    // The property that matters most: the worst a forged id can do is name a
    // path on the configured server.
    const id = buildSeriesId('vevent', '/tester/work/', 'x.ics');
    for (const part of id.split('.')) {
      expect(Buffer.from(part, 'base64url').toString('utf8')).not.toMatch(
        /^https?:/
      );
    }
    expect(id).not.toContain('//');
  });
});
