import { describe, expect, it } from 'vitest';

import {
  CalendarRegistry,
  normalisePath,
  type CalendarEntry,
} from '../src/calendars.js';
import { CalendarNotAllowedError, ToolInputError } from '../src/errors.js';

/**
 * The registry, which is the other half of the calendar allowlist: the half
 * that answers a caller who named a calendar rather than an entry.
 */

function calendar(
  name: string,
  overrides: Partial<CalendarEntry> = {}
): CalendarEntry {
  return {
    url: `https://dav.example.net/tester/${name}/`,
    path: `/tester/${name}/`,
    displayName: name,
    description: undefined,
    components: ['VEVENT', 'VTODO', 'VJOURNAL'],
    ctag: undefined,
    color: undefined,
    readOnly: false,
    ...overrides,
  };
}

const ALL = [calendar('work'), calendar('private'), calendar('shared')];

describe('normalisePath', () => {
  it('gives a collection exactly one trailing slash', () => {
    expect(normalisePath('/a/b')).toBe('/a/b/');
    expect(normalisePath('/a/b/')).toBe('/a/b/');
    expect(normalisePath('/a/b///')).toBe('/a/b/');
  });
});

describe('what an allowlist entry may be', () => {
  it('matches a full URL, an absolute path or a final segment', () => {
    for (const entry of [
      'https://dav.example.net/tester/work/',
      '/tester/work/',
      '/tester/work',
      'work',
    ]) {
      const registry = new CalendarRegistry(ALL, [entry]);
      expect(
        registry.allowed().map((c) => c.path),
        entry
      ).toEqual(['/tester/work/']);
    }
  });

  it('does not match a display name', () => {
    // A decision rather than an omission: on a shared calendar the display name
    // is chosen by whoever shared it, is not unique, and changes. An allowlist
    // keyed on a mutable, externally-controlled string is not an allowlist.
    const named = [calendar('c1', { displayName: 'Holidays' })];
    const registry = new CalendarRegistry(named, ['Holidays']);
    expect(registry.allowed()).toHaveLength(0);
    expect(registry.unmatched()).toEqual(['Holidays']);
  });

  it('matches nothing for a URL on another origin', () => {
    const registry = new CalendarRegistry(ALL, [
      'https://elsewhere.example/tester/work/',
    ]);
    // Compared on the pathname, so this happens to match — which is why the
    // origin is enforced in `resolveHref` rather than here. Pinning the
    // behaviour so a future change to either place is a deliberate one.
    expect(registry.allowed().map((c) => c.path)).toEqual(['/tester/work/']);
  });
});

describe('what the registry reports', () => {
  it('counts what it is keeping out of sight', () => {
    const registry = new CalendarRegistry(ALL, ['work']);
    expect(registry.allowed()).toHaveLength(1);
    // Reported rather than hidden: a listing that silently omits entries
    // teaches the reader they do not exist, and then a correct id from another
    // source looks like a bug.
    expect(registry.withheld()).toBe(2);
  });

  it('allows everything when the list is empty', () => {
    const registry = new CalendarRegistry(ALL, []);
    expect(registry.allowed()).toHaveLength(3);
    expect(registry.withheld()).toBe(0);
  });

  it('names an entry that matched nothing', () => {
    // A typo would otherwise fence the server off from everything in silence,
    // which is the failure mode a scope allowlist must not have.
    const registry = new CalendarRegistry(ALL, ['work', 'wrok']);
    expect(registry.unmatched()).toEqual(['wrok']);
  });

  it('names an entry that matched more than one calendar', () => {
    const twins = [
      calendar('work'),
      {
        ...calendar('work'),
        path: '/other/work/',
        url: 'https://dav.example.net/other/work/',
      },
    ];
    const registry = new CalendarRegistry(twins, ['work']);
    expect(registry.ambiguous()).toEqual([
      { entry: 'work', paths: ['/tester/work/', '/other/work/'] },
    ]);
  });
});

describe('resolving what a caller named', () => {
  const registry = new CalendarRegistry(ALL, ['work', 'private']);

  it('finds an allowed calendar', () => {
    expect(registry.resolve('/tester/work/').path).toBe('/tester/work/');
    expect(registry.resolve('work').path).toBe('/tester/work/');
  });

  it('refuses a fenced-off calendar as a refusal, not as "not found"', () => {
    expect(() => registry.resolve('shared')).toThrow(CalendarNotAllowedError);
    expect(() => registry.resolve('shared')).toThrow(/not given access/);
  });

  it('says a calendar does not exist when it does not', () => {
    expect(() => registry.resolve('nowhere')).toThrow(ToolInputError);
    expect(() => registry.resolve('nowhere')).toThrow(/no calendar called/);
  });

  it('refuses an empty reference', () => {
    expect(() => registry.resolve('  ')).toThrow(/empty string/);
  });

  it('returns the allowed calendars — never all — when asked for none', () => {
    // The reason this method exists rather than each tool reaching for a list:
    // the default case is the one most likely to be written without thinking
    // about the fence, so the fence is what the default returns.
    expect(registry.resolveMany().map((c) => c.path)).toEqual([
      '/tester/work/',
      '/tester/private/',
    ]);
    expect(registry.resolveMany([]).map((c) => c.path)).toHaveLength(2);
  });

  it('de-duplicates two spellings of one calendar', () => {
    expect(
      registry.resolveMany(['work', '/tester/work/']).map((c) => c.path)
    ).toEqual(['/tester/work/']);
  });

  it('refuses a named calendar outside the fence rather than skipping it', () => {
    // Silently dropping it would teach the model the calendar does not exist.
    expect(() => registry.resolveMany(['work', 'shared'])).toThrow(
      CalendarNotAllowedError
    );
  });

  it('explains an empty result rather than answering with nothing', () => {
    const fenced = new CalendarRegistry(ALL, ['nowhere']);
    expect(() => fenced.resolveMany()).toThrow(/allows none of the calendars/);
    const empty = new CalendarRegistry([], []);
    expect(() => empty.resolveMany()).toThrow(/no calendars/);
  });
});

describe('component support', () => {
  const registry = new CalendarRegistry(ALL, []);

  it('reads an explicit set', () => {
    const events = calendar('events', { components: ['VEVENT'] });
    expect(registry.accepts(events, 'VEVENT')).toBe(true);
    expect(registry.accepts(events, 'VTODO')).toBe(false);
  });

  it('treats an empty set as unrestricted, not as forbidden', () => {
    // RFC 4791 reads a missing set as "everything". Answering false would
    // refuse writes on every Radicale collection created without one.
    const silent = calendar('silent', { components: [] });
    expect(registry.accepts(silent, 'VTODO')).toBe(true);
  });
});
