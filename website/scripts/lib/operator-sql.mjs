/* Built with Meta Muse. */
// Canonical operator disable operation. scripts/disable-user.mjs and the
// regression suite execute these EXACT statements: tests apply them to the
// D1 shim, the script applies them via wrangler --file.
export function sqlQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

export function disableUserStatements({ userId, email = null, deletePassword = false, revokedAt = null } = {}) {
  if (!userId || typeof userId !== 'string') throw new Error('disableUserStatements requires a userId.');
  const id = sqlQuote(userId);
  const now = sqlQuote(revokedAt || new Date().toISOString());
  // NOTE: the demo column is deliberately never referenced. Disabling
  // preserves the account's sandbox classification; flipping demo=1 to
  // demo=0 would promote a demo session to live authority (F77 finding 2).
  const stmts = [
    `UPDATE "user" SET disabled = 1 WHERE id = ${id}`,
    `DELETE FROM session WHERE userId = ${id}`,
    `UPDATE key_verifiers SET revoked_at = ${now} WHERE owner_id = ${id} AND revoked_at IS NULL`
  ];
  if (email) {
    stmts.push(`DELETE FROM allowlist WHERE email = ${sqlQuote(String(email).trim().toLowerCase())}`);
  }
  if (deletePassword) {
    stmts.push(`DELETE FROM account WHERE providerId = 'credential' AND userId = ${id}`);
  }
  return stmts;
}
