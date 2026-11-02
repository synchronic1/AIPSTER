// Administrator-access decision for the /app/experiments/dsh-dgm/ page.
//
// The /app/* and /admin/* shells are public static assets: anyone can download
// them and they carry no authority of their own. This module only decides
// whether the page should render the interactive prototype, using the
// existing read-only administration gate:
//
//   GET /api/admin/v1/status  ->  requireAdmin(ctx, 'admin.status')
//
// That route authorizes only a session actor holding a live (unrevoked,
// unexpired) admin_grants row with a recognized role and the `platform` scope.
// Demo sessions, API-key and heartbeat-key callers, expired or revoked grants
// and callers with no grant are refused server-side; the client never decides
// who is an administrator. On success the server answers 200 with
//
//   { schema_version: 'admin.status.v1', admin, elevation, mutations,
//     grant: { role, scope, expires_at }, observed_at }
//
// and on refusal it answers 401 AUTH_REQUIRED (no session) or 403
// ADMIN_FORBIDDEN (signed in, not authorized). This module only maps those
// answers to a UI state and fails closed on anything else.

export const ADMIN_STATUS_ENDPOINT = '/api/admin/v1/status';
export const ADMIN_STATUS_SCHEMA = 'admin.status.v1';
export const ADMIN_GRANT_SCOPE = 'platform';

// PRD Section 5 roles, exactly the set src/admin/router.mjs recognizes. An
// unknown role authorizes nothing on the server, so it must not reveal the
// view here either. A test keeps this list equal to the router's.
export const ADMIN_ROLES = Object.freeze([
  'operations_observer',
  'access_administrator',
  'security_reviewer',
  'support_triager',
  'engineering_reviewer',
  'role_grant_authority'
]);

// Mirrors the router's grantIsLive: canonical UTC only (YYYY-MM-DDTHH:MM:SS
// [.sss]Z) naming a real instant, and strictly after the observation time.
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function instantOf(value) {
  if (typeof value !== 'string' || !CANONICAL_UTC.test(value)) return NaN;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return NaN;
  const roundTrip = new Date(ms).toISOString();
  return roundTrip === value || roundTrip === value.replace('Z', '.000Z') ? ms : NaN;
}

function grantIsLive(expiresAt, observedAt) {
  if (expiresAt === null) return true;
  const expires = instantOf(expiresAt);
  return Number.isFinite(expires) && expires > observedAt;
}

export const ACCESS_STATES = Object.freeze({
  AUTHORIZED: 'authorized',
  ANONYMOUS: 'anonymous',
  DENIED: 'denied',
  UNAVAILABLE: 'unavailable'
});

const MESSAGES = Object.freeze({
  [ACCESS_STATES.ANONYMOUS]:
    'You are not signed in. The interactive experiment is available only to an administrator '
    + 'with a live platform grant. Sign in to the AIPSTER control panel and return to this page.',
  [ACCESS_STATES.DENIED]:
    'This account is not authorized for administration, so the interactive experiment did not load. '
    + 'An ordinary account, a demo account, an expired or revoked grant and an API-key caller are '
    + 'all refused by the server. Ask an administrator for a platform grant if you need access.',
  [ACCESS_STATES.UNAVAILABLE]:
    'The administrator authorization check did not complete, so the interactive experiment did not load. '
    + 'Try again from the AIPSTER control panel.'
});

function refuse(state, message) {
  return { state, load: false, message: message || MESSAGES[state], role: null, scope: null };
}

// input: { status, payload, error }
//   status  HTTP status of GET /api/admin/v1/status, if a response arrived
//   payload parsed JSON body, or null when it was not JSON
//   error   a short reason string when the request itself failed
export function decideAdminAccess(input) {
  const { status, payload, error } = input && typeof input === 'object' ? input : {};

  // A failed request, or a body we could not parse, is a check we could not
  // complete. It is never treated as authorization.
  if (error) return refuse(ACCESS_STATES.UNAVAILABLE);
  if (!Number.isInteger(status) || status < 100 || status > 599) return refuse(ACCESS_STATES.UNAVAILABLE);
  if (status === 401) return refuse(ACCESS_STATES.ANONYMOUS);
  if (status === 403) return refuse(ACCESS_STATES.DENIED);
  if (status !== 200) return refuse(ACCESS_STATES.UNAVAILABLE);

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return refuse(ACCESS_STATES.UNAVAILABLE);
  }
  // Only the documented status envelope authorizes anything. A 200 from some
  // other route, or a future shape, leaves the page closed.
  if (payload.schema_version !== ADMIN_STATUS_SCHEMA) return refuse(ACCESS_STATES.UNAVAILABLE);

  // The documented envelope, field for field. A 200 missing any of these, or
  // naming another admin/elevation/mutation state, is not this route's answer,
  // so the check did not complete. `observed_at` must be a real instant: it is
  // the reference for grant expiry.
  const observedAt = instantOf(payload.observed_at);
  if (payload.admin !== 'scaffold' || payload.elevation !== 'not_implemented'
    || payload.mutations !== 'disabled' || !Number.isFinite(observedAt)) {
    return refuse(ACCESS_STATES.UNAVAILABLE);
  }

  const grant = payload.grant;
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return refuse(ACCESS_STATES.DENIED);
  // Only roles the server can hold under `platform`, and only a grant that is
  // still live at the observation time, may reveal the view.
  if (typeof grant.role !== 'string' || !ADMIN_ROLES.includes(grant.role)) return refuse(ACCESS_STATES.DENIED);
  if (grant.scope !== ADMIN_GRANT_SCOPE) return refuse(ACCESS_STATES.DENIED);
  if (!Object.hasOwn(grant, 'expires_at')) return refuse(ACCESS_STATES.UNAVAILABLE);
  if (!grantIsLive(grant.expires_at, observedAt)) return refuse(ACCESS_STATES.DENIED);

  return {
    state: ACCESS_STATES.AUTHORIZED,
    load: true,
    role: grant.role,
    scope: grant.scope,
    message: `Administrator access verified: role ${grant.role}, scope ${grant.scope}. `
      + 'The experiment is still off until you enable it below.'
  };
}
