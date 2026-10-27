/* Built with Meta Muse. */
// Better Auth factory for the Cloudflare Worker: GitHub OAuth, D1 sessions,
// invited-email gate. Verified against better-auth 1.7.14: raw D1Database is a
// first-class `database` option, telemetry defaults off (also disabled here),
// Workers integration mounts at /api/auth/* with the nodejs_als flag.
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { username } from 'better-auth/plugins/username';
import { first } from './store.js';

export const OAUTH_SCOPES = ['read:user', 'user:email'];
export const OAUTH_CALLBACK_PATH = '/api/auth/callback/github';

export function configError(message) {
  return Object.assign(new Error(message), { status: 500, code: 'CONFIG' });
}

export async function isInvited(db, email) {
  if (typeof email !== 'string') return false;
  const norm = email.trim().toLowerCase();
  if (!norm) return false;
  const row = await first(db, 'SELECT email FROM allowlist WHERE email = ?', norm);
  return !!row;
}

// The real OAuth invitation gate (the databaseHooks wrapper below is a thin
// caller). Requires BOTH allowlist membership AND a provider-verified email:
// the GitHub provider supplies emailVerified from the verified-emails API.
export async function checkInvitation(db, user) {
  const email = user && user.email;
  if (!isEmailLike(email) || !(await isInvited(db, email))) {
    throw new APIError(403, { message: 'This sign-in is not invited.', code: 'NOT_INVITED' });
  }
  if (!user || user.emailVerified !== true) {
    throw new APIError(403, { message: 'A provider-verified email is required.', code: 'NOT_VERIFIED' });
  }
  return true;
}

function isEmailLike(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

// This app needs identity + sessions, not provider API access: drop OAuth
// access/refresh/ID tokens (and their expiries) before they are persisted.
// Credential passwords and all other fields pass through untouched.
export function stripProviderTokens(acct) {
  if (!acct || typeof acct !== 'object') return acct;
  return {
    ...acct,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null
  };
}

function readEnv(env, name) {
  const v = env ? env[name] : undefined;
  return typeof v === 'string' ? v : '';
}

export function createAuth(env) {
  const secret = readEnv(env, 'BETTER_AUTH_SECRET');
  const baseURL = readEnv(env, 'BETTER_AUTH_URL');
  if (!env || !env.DB) throw configError('Authentication is not configured.');
  if (!secret || secret.length < 32) throw configError('Authentication is not configured.');
  if (!baseURL) throw configError('Authentication is not configured.');
  const clientId = readEnv(env, 'GITHUB_CLIENT_ID');
  const clientSecret = readEnv(env, 'GITHUB_CLIENT_SECRET');
  const secure = baseURL.startsWith('https://');
  return betterAuth({
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    telemetry: { enabled: false },
    database: env.DB,
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, autoSignIn: false },
    user: {
      // Demo-workspace flag (migration 0003). input:false: never client-set;
      // only the setup script / rollout owner writes it.
      additionalFields: {
        demo: { type: 'number', required: false, defaultValue: 0, input: false },
        disabled: { type: 'number', required: false, defaultValue: 0, input: false }
      }
    },
    plugins: [username()],
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: { '/sign-in/username': { window: 60, max: 10 }, '/sign-in/email': { window: 60, max: 10 } }
    },
    session: { expiresIn: 12 * 60 * 60, updateAge: 60 * 60 },
    advanced: {
      cookies: {
        session_token: {
          attributes: { secure, httpOnly: true, sameSite: 'lax', path: '/' }
        }
      }
    },
    socialProviders: clientId && clientSecret ? {
      github: { clientId, clientSecret, scope: OAUTH_SCOPES }
    } : {},
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Invited-test-user policy (assumed; see docs/cloudflare-integration-plan.md).
            // Requires allowlist membership AND a provider-verified email.
            await checkInvitation(env.DB, user);
            return { data: user };
          }
        }
      },
      account: {
        create: { before: async (account) => ({ data: stripProviderTokens(account) }) },
        update: { before: async (account) => ({ data: stripProviderTokens(account) }) }
      },
      session: {
        create: {
          before: async (session) => {
            // Disabled users cannot mint new sessions (OAuth or password).
            // Existing sessions stop authorizing API calls via actorFrom.
            if (session && session.userId) {
              const row = await first(env.DB, 'SELECT disabled FROM "user" WHERE id = ?', session.userId);
              if (row && Number(row.disabled) === 1) {
                throw new APIError(403, { message: 'This sign-in is disabled.', code: 'ACCOUNT_DISABLED' });
              }
            }
            return { data: session };
          }
        }
      }
    }
  });
}

export function oauthConfigured(env) {
  return !!(readEnv(env, 'GITHUB_CLIENT_ID') && readEnv(env, 'GITHUB_CLIENT_SECRET'));
}

export async function sessionUser(auth, request) {
  try {
    const data = await auth.api.getSession({ headers: request.headers });
    if (data && data.user) return { user: data.user, session: data.session };
    return null;
  } catch {
    return null;
  }
}
