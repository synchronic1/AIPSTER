/* Built with Meta Muse. */
// Better Auth factory for the Cloudflare Worker: GitHub OAuth, D1 sessions,
// public registration with a provider-verified-email gate. The earlier
// invited-test-user allowlist policy was an assumption and is rejected:
// any GitHub user with a provider-verified email may register.
// Verified against better-auth 1.7.14: raw D1Database is a
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

// The real OAuth signup gate (the databaseHooks wrapper below is a thin
// caller). Public registration: any signup is allowed, but the email must
// be provider-verified. emailVerified comes server-side from the GitHub
// provider's verified-emails API call -- never from a client claim -- and
// password signup stays closed (disableSignUp), so this hook only ever
// sees provider-supplied identities. Missing, malformed, or unverified
// emails are rejected with one code so the login page can explain it.
export async function requireVerifiedEmail(user) {
  const email = user && user.email;
  if (!isEmailLike(email) || !user || user.emailVerified !== true) {
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
    account: {
      // Never link a new OAuth identity to an existing user merely
      // because the email text matches. Without this, better-auth
      // implicitly links a verified provider email to the local user
      // with the same verified email -- an account-takeover vector.
      // Session-initiated link-social keeps working; only the silent
      // match path is closed. A colliding login fails closed with
      // `account_not_linked` instead of joining the wrong account.
      accountLinking: { disableImplicitLinking: true }
    },
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
            // Public registration: no invitation. Still requires a
            // provider-verified email, checked server-side.
            await requireVerifiedEmail(user);
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
