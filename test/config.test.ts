import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadConfig,
  missingConfigKeys,
  parseElicitation,
} from '../src/config.js';

/**
 * The environment is the whole of this server's configuration, and several of
 * these variables decide whether a protection is on. The direction of each one
 * decides how strictly it is read, and that asymmetry is what these tests pin.
 */

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    CALDAV_URL: 'https://dav.example.net',
    CALDAV_USERNAME: 'tester',
    CALDAV_PASSWORD: 'not-a-secret',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

/** Captures an exit instead of taking the process down with it. */
function catchExit() {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exited');
  }) as never);
  return { errors, exit };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('credentials', () => {
  it('deletes the whole credential from the environment', () => {
    const source = env({ CALDAV_TOKEN: undefined });
    loadConfig(source);
    // Before any branch that can exit or return: an exit above this line would
    // leave the credential there for whatever runs next.
    expect(source.CALDAV_PASSWORD).toBeUndefined();
    expect(source.CALDAV_TOKEN).toBeUndefined();
    // The username goes too. It is half of a credential rather than a secret
    // on its own, and leaving one of the pair behind reads as a judgement that
    // it was harmless when it was really an omission.
    expect(source.CALDAV_USERNAME).toBeUndefined();
  });

  it('deletes them even when the URL is missing entirely', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const source = env({ CALDAV_URL: undefined });
    loadConfig(source);
    expect(source.CALDAV_PASSWORD).toBeUndefined();
    expect(source.CALDAV_USERNAME).toBeUndefined();
  });

  it('accepts a bearer token instead of a password', () => {
    const config = loadConfig(
      env({
        CALDAV_USERNAME: undefined,
        CALDAV_PASSWORD: undefined,
        CALDAV_TOKEN: 'abc',
      })
    );
    expect(config.token).toBe('abc');
    expect(missingConfigKeys(config)).toEqual([]);
  });

  it('refuses a token and a password together rather than picking one', () => {
    const { errors } = catchExit();
    expect(() => loadConfig(env({ CALDAV_TOKEN: 'abc' }))).toThrow('exited');
    expect(errors.join(' ')).toMatch(/not both/);
  });

  it('reports what is missing without the server refusing to start', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = loadConfig(env({ CALDAV_PASSWORD: undefined }));
    // Startable without credentials on purpose: a registry or a sandbox
    // inspector has to be able to complete the handshake and list the tools.
    expect(missingConfigKeys(config)).toEqual([
      'CALDAV_USERNAME + CALDAV_PASSWORD (or CALDAV_TOKEN)',
    ]);
  });
});

describe('the URL', () => {
  it('keeps a path and drops only trailing slashes', () => {
    // https://host/dav.php is Baikal's real shape; stripping the path would
    // send discovery to a root that answers 404.
    expect(
      loadConfig(env({ CALDAV_URL: 'https://example.net/dav.php//' })).url
    ).toBe('https://example.net/dav.php');
  });

  it('refuses a URL that carries credentials', () => {
    const { errors } = catchExit();
    expect(() =>
      loadConfig(env({ CALDAV_URL: 'https://a:b@example.net' }))
    ).toThrow('exited');
    expect(errors.join(' ')).toMatch(/must not contain credentials/);
  });

  it('redacts credentials from a URL that does not even parse', () => {
    // The userinfo check below only runs once the URL parses, so a value that
    // fails to parse *and* carries credentials would otherwise print the
    // password into the MCP client's log.
    const { errors } = catchExit();
    expect(() =>
      loadConfig(env({ CALDAV_URL: 'https://admin:s3cret@host:99999' }))
    ).toThrow('exited');
    expect(errors.join(' ')).not.toMatch(/s3cret/);
    expect(errors.join(' ')).toMatch(/\*\*\*@/);
  });

  it('refuses a non-http scheme', () => {
    const { errors } = catchExit();
    expect(() => loadConfig(env({ CALDAV_URL: 'file:///etc/passwd' }))).toThrow(
      'exited'
    );
    expect(errors.join(' ')).toMatch(/http:\/\/ or https:\/\//);
  });

  it('warns about plain http to a remote host but not to loopback', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    loadConfig(env({ CALDAV_URL: 'http://example.net' }));
    expect(warn.mock.calls.flat().join(' ')).toMatch(/unencrypted/);

    warn.mockClear();
    loadConfig(env({ CALDAV_URL: 'http://[::ffff:127.0.0.1]:5232' }));
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/unencrypted/);
  });
});

describe('switches, and how strictly each is read', () => {
  it('reads a switch that turns a protection ON tolerantly', () => {
    // =1 from a compose file, =yes from a shell script, =TRUE from Windows, a
    // trailing space from a copied .env line. An `=== 'true'` comparison
    // answers all four with a server that quietly exposes every write tool.
    for (const value of ['1', 'true', 'TRUE', 'yes', ' true ']) {
      expect(loadConfig(env({ CALDAV_READ_ONLY: value })).readOnly).toBe(true);
    }
    for (const value of ['0', 'false', 'no', '']) {
      expect(loadConfig(env({ CALDAV_READ_ONLY: value })).readOnly).toBe(false);
    }
  });

  it('reads a switch that LIFTS a protection strictly', () => {
    // The opposite direction: anything not spelled exactly leaves certificate
    // checking on.
    expect(loadConfig(env({ CALDAV_INSECURE_TLS: 'true' })).insecureTls).toBe(
      true
    );
    for (const value of ['TRUE', '1', 'yes', ' true ']) {
      expect(loadConfig(env({ CALDAV_INSECURE_TLS: value })).insecureTls).toBe(
        false
      );
    }
  });

  it('refuses to start on an ELICITATION value it does not recognise', () => {
    expect(parseElicitation(undefined)).toBe(true);
    expect(parseElicitation('')).toBe(true);
    expect(parseElicitation('true')).toBe(true);
    expect(parseElicitation('false')).toBe(false);

    const { errors } = catchExit();
    // Fatal because this is the one variable of the family that defaults to
    // *on*: a typo would leave the dialog running while the operator believes
    // it is off, and they would have no way to find out.
    expect(() => parseElicitation('nope')).toThrow('exited');
    expect(errors.join(' ')).toMatch(/must be "true" or "false"/);
  });
});

describe('the calendar allowlist', () => {
  it('splits a comma-separated list and trims it', () => {
    expect(
      loadConfig(env({ CALDAV_CALENDARS: ' work , private ,, ' })).calendars
    ).toEqual(['work', 'private']);
  });

  it('refuses a variable that is set but empty', () => {
    // "Set to nothing" plausibly means "no calendars at all". Answering that by
    // opening every calendar is the one outcome nobody wants.
    const { errors } = catchExit();
    expect(() => loadConfig(env({ CALDAV_CALENDARS: '  ' }))).toThrow('exited');
    expect(errors.join(' ')).toMatch(/set but empty/);
  });

  it('allows every calendar when the variable is absent', () => {
    expect(loadConfig(env()).calendars).toEqual([]);
  });
});

describe('the timezone', () => {
  it('defaults to UTC and accepts an IANA name', () => {
    expect(loadConfig(env()).timezone).toBe('UTC');
    expect(loadConfig(env({ CALDAV_TIMEZONE: 'Europe/Berlin' })).timezone).toBe(
      'Europe/Berlin'
    );
  });

  it('refuses a zone the platform does not know', () => {
    // An unrecognised zone would be treated as floating time and every
    // timestamp this server writes would land in the wrong hour, silently.
    const { errors } = catchExit();
    expect(() => loadConfig(env({ CALDAV_TIMEZONE: 'Europe/Berlim' }))).toThrow(
      'exited'
    );
    expect(errors.join(' ')).toMatch(/not an IANA time zone/);
  });
});

describe('the entry limit', () => {
  it('defaults, and accepts a value inside the ceiling', () => {
    expect(loadConfig(env()).maxEntries).toBe(100);
    expect(loadConfig(env({ CALDAV_MAX_EVENTS: '250' })).maxEntries).toBe(250);
  });

  it('refuses a value outside it', () => {
    const { errors } = catchExit();
    expect(() => loadConfig(env({ CALDAV_MAX_EVENTS: '5000' }))).toThrow(
      'exited'
    );
    expect(errors.join(' ')).toMatch(/between 1 and 500/);
  });

  it('refuses a value that is not a number', () => {
    catchExit();
    expect(() => loadConfig(env({ CALDAV_MAX_EVENTS: 'lots' }))).toThrow(
      'exited'
    );
  });
});
