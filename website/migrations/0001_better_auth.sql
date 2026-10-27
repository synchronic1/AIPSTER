-- Built with Meta Muse.
-- Migration 0001: Better Auth core tables (user, session, account, verification).
-- Matches better-auth 1.7.14 expectations; verified by running real session
-- flows against this schema in website/tests. Columns other than primary keys
-- are nullable for forward compatibility; the application never reads these
-- tables directly except user(id, name, email).

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  emailVerified INTEGER,
  image TEXT,
  createdAt TEXT,
  updatedAt TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email ON "user"(email);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  expiresAt TEXT,
  token TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_token ON session(token);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(userId);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  accountId TEXT,
  providerId TEXT,
  userId TEXT REFERENCES "user"(id),
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT,
  updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_user ON account(userId);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT,
  value TEXT,
  expiresAt TEXT,
  createdAt TEXT,
  updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_verification_id ON verification(identifier);
