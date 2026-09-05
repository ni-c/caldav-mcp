/**
 * Errors this server raises before, or instead of, talking to the CalDAV server.
 *
 * They live in their own module rather than next to the code that throws them so
 * that `result.ts` can map every one of them to a tool result without importing
 * half the server — `run()` is the only place that catches, and it has to know
 * all of these.
 */

/** A caller's arguments could not be used. Never reaches the network. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * The answer would not fit inside the response budget, and nothing was left to
 * drop. A refusal, so it becomes an error result rather than an envelope of a
 * shape the tool never declared.
 */
export class ResultTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultTooLargeError';
  }
}

/**
 * The target is outside `CALDAV_CALENDARS`.
 *
 * Separate from {@link ToolInputError} because the two say different things to a
 * reader: one is "you got the arguments wrong", this one is "the operator fenced
 * this off". Conflating them would send somebody looking for a typo in a
 * calendar name that is spelled correctly and simply not permitted.
 */
export class CalendarNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarNotAllowedError';
  }
}

/**
 * A resource changed between the read and the write, so nothing was written.
 *
 * Carries the state read back afterwards, so the tool can tell the caller what
 * the entry is now instead of quoting `412` at them.
 */
export class PreconditionFailedError extends Error {
  constructor(
    message: string,
    public readonly current?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PreconditionFailedError';
  }
}
