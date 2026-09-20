/**
 * Controller ruling 1: the paste encoding is `@orc/core`'s contract (contracts §13,
 * validated by spike S2/S8: bracketed paste, 120 ms submit delay, 50/50 scripted replies
 * landed in order, no idle detection needed). This module must not re-create it — it
 * re-exports the core implementations verbatim so the daemon's PTY layer has a single,
 * stable import path (`./input.ts`) without duplicating logic that already has its own
 * unit tests in `packages/core/src/pty/paste.test.ts`.
 */
export { encodePaste, sendText } from '@orc/core';

/** Mirrors @orc/core's sendText default (spike S2/S8: no evidence it needs raising). */
export const SUBMIT_DELAY_MS = 120;
