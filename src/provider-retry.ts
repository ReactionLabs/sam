/**
 * Provider overload resilience (Dip live defect, 2026-11-15
 * ~15:48 EST).
 *
 * Pain: Dip asked "Can u make an artifact?" twice in a dashboard
 * chat and both turns died on the spot - the ledger showed
 * turn-failed "Model connector request failed (HTTP 529)" and
 * the queue marked his messages failed. MiniMax was in an
 * overload window (a live CLI ping minutes later still returned
 * 529; the same class had already killed two acceptance attempts
 * earlier that day). SAM's failure bookkeeping worked exactly
 * as designed - the messages were marked failed, never lost -
 * but a transient provider overload ate the owner's turn
 * instantly, with no retry and no word to the owner: his only
 * signal was a "failed" tag on his message.
 *
 * The fix, two halves:
 *
 * - BOUNDED IN-TURN RETRY (openai-compatible.ts, the connector
 *   turn path both chat loops ride): a request that fails with
 *   a transient status - HTTP 429 or any 5xx, 529 included -
 *   is retried in place, TRANSIENT_RETRY_LIMIT retries on the
 *   TRANSIENT_RETRY_DELAYS_MS backoff schedule (3.5s of added
 *   wait at most, far inside the 180s interactive deadline).
 *   Nothing has executed for a failed request, so every retry
 *   is safe. The backoff rides the turn's abort signal, so a
 *   Reset or the deadline cancels a pending retry immediately.
 *   Non-transient statuses (400 / 401 / 403 and friends) never
 *   retry: they surface exactly as before. Each scheduled
 *   retry is reported through the provider's onProviderRetry
 *   sink, and the turn layer ledgers one provider-retry line
 *   per retry, so the record shows the hiccup and the recovery.
 *
 * - THE OVERLOAD NOTE (agent-turn.ts): when the retries are
 *   spent and the last route still fails with a 5xx, the turn
 *   still fails - the queue marks the message failed, not
 *   lost, exactly as before - but the chat first gets one
 *   plain note in SAM's own voice: the provider is overloaded,
 *   the message is saved, send again shortly. The owner no
 *   longer stares at a bare failed tag.
 *
 * The two failure classes stay distinct, by status:
 * - 429 / quota is the RATE-LIMIT class (rate-limit.ts): it
 *   retries like any transient failure, and if it still fails
 *   it takes the existing grace path - the episode, the one
 *   plain grace message, then silence. The overload note
 *   NEVER fires for it: out of tokens is not an overload.
 * - 5xx is the OVERLOAD class (this module): it retries, and
 *   on exhaustion the note above speaks. The grace episode
 *   never opens for it.
 * The provider layer strips response bodies, so the durable
 * signal is the status in the thrown error's message, in its
 * three shapes - "Model request failed", "Model connector
 * request failed", "Model tool request failed" - the same
 * boundary the rate-limit classifier reads.
 */

/** Retries after the first attempt for one transient failure. */
export const TRANSIENT_RETRY_LIMIT = 3;
/** Backoff before retry 1, 2, 3. The whole schedule adds at
 *  most 3.5s to a turn - far inside the 180s interactive
 *  deadline - because its job is riding out a seconds-long
 *  blip; a minutes-long overload window is the note's job. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000];

/** The plain outage note, in SAM's voice: no raw error text,
 *  no error codes, no platform language - the same discipline
 *  as the rate-limit grace message. */
export const PROVIDER_OVERLOAD_MESSAGE =
  "Heads up, the model I think with is overloaded right now and could not answer. Your message is saved here and nothing is lost. Give it a short moment and send again, and I will pick it back up.";

const HTTP_STATUS_SHAPE = /^Model (?:connector |tool )?request failed \(HTTP (\d{3})\)/;

/** The HTTP status a provider failure carries, or null when
 *  the error is not one of the three provider status shapes
 *  (timeouts, network failures, empty / unsafe completions
 *  carry no status and are not this module's class). */
export function providerHttpStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = HTTP_STATUS_SHAPE.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isSafeInteger(status) ? status : null;
}

/** Transient by status: 429 (a per-minute limit can clear
 *  inside the backoff) and the whole 5xx range, 529
 *  included. Everything else - 400, 401, 403, 404 - is a
 *  real failure that retrying cannot fix. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function isTransientProviderError(error: unknown): boolean {
  const status = providerHttpStatus(error);
  return status !== null && isTransientHttpStatus(status);
}

/** The overload-note class: 5xx only. A 429 belongs to the
 *  rate-limit grace path (rate-limit.ts) and never classifies
 *  here, so the two owner-facing messages can never collide
 *  on the same failure. */
export function isProviderOverloadError(error: unknown): boolean {
  const status = providerHttpStatus(error);
  return status !== null && status >= 500 && status <= 599;
}
