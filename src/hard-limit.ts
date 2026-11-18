import vm from 'node:vm';

import { ToolInputError } from './errors.js';
import { resetGuards } from './ical-guard.js';

/**
 * A hard limit on the time synchronous work may take, enforced by V8.
 *
 * ical.js has loops whose length a stored entry chooses. ical-guard.ts bounds
 * the ones found so far, and five rounds of review kept finding another. This
 * is the line that does not depend on finding them: the work runs as the
 * callback of a script started with a `timeout`, and when the time is up V8
 * terminates whatever is executing — this server's code, ical.js, any loop.
 * The termination cannot be caught on the way out and runs no `finally`, so
 * the guard state is reset here afterwards; everything the work had written
 * to the outside before that point stays as it was.
 *
 * Starting the watchdog costs about a millisecond, so listings use
 * {@link eachBounded}, which puts a whole batch under one limit.
 */

export class HardLimitExceeded extends ToolInputError {
  constructor() {
    super(
      'caldav-mcp: the stored entry took longer to evaluate than this server ' +
        'allows. This is the stored entry, not the arguments of this call.'
    );
    this.name = 'HardLimitExceeded';
  }
}

const context = vm.createContext({});
const script = new vm.Script('run()');

/** Runs `work` and returns its result, or throws {@link HardLimitExceeded}. */
export function withHardLimit<T>(ms: number, work: () => T): T {
  let result: T | undefined;
  context.run = () => {
    result = work();
  };
  try {
    script.runInContext(context, { timeout: Math.max(1, Math.ceil(ms)) });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      resetGuards();
      throw new HardLimitExceeded();
    }
    throw error;
  } finally {
    context.run = undefined;
  }
  return result as T;
}

/** The time one entry may take on its own, parse to last occurrence. */
export const ENTRY_LIMIT_MS = 1000;

/**
 * The same for a tool that reads or writes one entry, which may carry a large
 * inline attachment and is worth waiting longer for.
 */
export const SINGLE_ENTRY_LIMIT_MS = 3000;

/** Entries a call gives up on before it stops evaluating any more. */
export const MAX_OVERRUNS = 3;

/** Overruns counted across the batches of one call. */
export interface Overruns {
  count: number;
}

/**
 * Runs `work` over `items` in batches under one hard limit each. When a batch
 * is stopped, the entry it stopped in gets a limit of its own; stopped again,
 * it is handed to `onOverrun` and skipped. After {@link MAX_OVERRUNS} such
 * entries in a call, the rest are handed to `onAbandoned` unevaluated, so a
 * calendar of hostile entries costs seconds, not one second each.
 *
 * `work` must catch its own errors; a termination passes through any catch.
 */
export function eachBounded<T>(
  items: readonly T[],
  overruns: Overruns,
  work: (item: T) => void,
  onOverrun: (item: T) => void,
  onAbandoned: (count: number) => void
): void {
  let index = 0;
  while (index < items.length) {
    if (overruns.count >= MAX_OVERRUNS) {
      onAbandoned(items.length - index);
      return;
    }
    const start = index;
    const progress = { index };
    try {
      withHardLimit(ENTRY_LIMIT_MS, () => {
        for (; progress.index < items.length; progress.index += 1) {
          work(items[progress.index] as T);
        }
      });
      return;
    } catch (error) {
      if (!(error instanceof HardLimitExceeded)) throw error;
      if (progress.index === start) {
        overruns.count += 1;
        onOverrun(items[progress.index] as T);
        index = progress.index + 1;
      } else {
        index = progress.index;
      }
    }
  }
}
