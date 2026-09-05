/**
 * The annotation blocks every tool declares, written out rather than defaulted.
 *
 * The specification says `destructiveHint` and `openWorldHint` both default to
 * **true**, so an omitted field is the *stronger* claim, not the neutral one: a
 * `create_event` that says nothing announces itself as destructive and
 * open-world. Every tool in this server therefore names all four.
 *
 * The line this family draws for `destructiveHint`, because the specification
 * only offers "destructive" against "additive only":
 *
 * > Content that a person wrote, replaced with no way back — destructive.
 * > A setting, a state or a marker, changed — not destructive.
 *
 * Whether the backend keeps history is what decides it, not the verb. CalDAV
 * keeps none: a PUT replaces the whole resource and there is no version to go
 * back to. So `update_event` here **is** destructive, where `update_page` in
 * wikijs-mcp is not — same verb, opposite answer, and the difference is the
 * backend rather than the wording.
 *
 * `idempotentHint` follows the specification's "no additional effect on its
 * environment": every `delete_*` is `true`, because deleting the same entry
 * twice leaves one thing deleted and the second answer is an answer rather than
 * an effect. Creating is `false`.
 *
 * `openWorldHint` is `false` everywhere in this server, including on
 * `respond_to_event`. The hint marks a tool that makes the instance reach an
 * address somebody else chose — the boundary `mcp-internal-hosts` watches. An
 * iTIP reply does leave the building, but this server still speaks only to the
 * one configured instance; the backend is what mails the organiser. That
 * consequence belongs in the approval dialog, which states it, rather than in a
 * hint that would stop meaning anything if it also covered "the backend may act
 * on this".
 */

/** A tool that only reads. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Adds something new. Two calls make two entries, so not idempotent. */
export const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Replaces text a person wrote, with no history behind it.
 *
 * Idempotent all the same: the same arguments twice leave the same state.
 * SEQUENCE counts revisions rather than describing the environment.
 */
export const REPLACE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Removes an entry, or an occurrence of one. */
export const DELETE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Changes a marker whose previous value the entry records.
 *
 * `complete_task` and `respond_to_event`: a task can be reopened and a PARTSTAT
 * can be set again to anything it was. This is the `set_message_flags` answer
 * rather than the `mark_articles` one, and the difference is that the previous
 * value is still written down.
 */
export const SET_STATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Moves an entry to another calendar.
 *
 * Destructive for the reason `move_messages` is in imap-mcp: the content
 * survives but the resource URL does not, so every id naming it stops working.
 * Not idempotent — after the first call the source is gone.
 */
export const MOVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
