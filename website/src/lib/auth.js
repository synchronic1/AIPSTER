/* Built with Meta Muse. */
// Better Auth factory for the Cloudflare Worker: GitHub OAuth, D1 sessions,
// invited-email gate. Verified against better-auth 1.7.14: raw D1Database is a
// first-class `database` option, telemetry defaults off (also disabled here),
// Workers integration mounts at /api/auth/* with the nodejs_als flag.
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
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
    emailAndPassword: { enabled: false },
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
            if (!(await isInvited(env.DB, user && user.email))) {
              throw new APIError(403, { message: 'This sign-in is not invited.', code: 'NOT_INVITED' });
            }
            return { data: user };
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
