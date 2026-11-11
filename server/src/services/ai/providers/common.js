import { HttpError } from '../../../lib/errors.js';

/**
 * Machine-readable error codes for AI calls. They reach the client as `code` (and details.code) on the JSON error.
 *   AI_NOT_CONFIGURED       503  no platform provider and no key of the user's own
 *   AI_QUOTA                429  the plan's monthly AI limit is used up (platform calls only)
 *   AI_KEY_REJECTED         400  the provider refused the user's own key (401/403)
 *   AI_PLATFORM_KEY_REJECTED 502 the provider refused the platform key (an admin must fix it)
 *   AI_KEY_UNREADABLE       400  the saved key can no longer be decrypted (server secret changed)
 *   AI_MODEL_NOT_FOUND      400  the provider does not offer the configured model (404)
 *   AI_PROVIDER_RATE_LIMIT  429  the provider itself is rate limiting (its 429)
 *   AI_REFUSED              502  the model declined the request (Claude stop_reason "refusal")
 *   AI_TRUNCATED            502  the reply hit the token limit before any usable answer
 *   AI_PROVIDER_ERROR       502  anything else: unreachable, timeout, 5xx, empty reply
 */
export function aiError(status, message, code, extra = {}) {
  return new HttpError(status, message, { code, ...extra });
}

export const errCode = (err) => err?.details?.code || null;
