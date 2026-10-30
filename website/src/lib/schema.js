// Readiness contract for the routes compiled into this worker. Keep this in
// step with required migration columns; table existence alone is insufficient.
// Federation's additive contract is required only when its router is enabled.
const appSchema = {
  user: 'id name email emailVerified image createdAt updatedAt username displayUsername demo disabled',
  session: 'id expiresAt token createdAt updatedAt ipAddress userAgent userId',
  account: 'id accountId providerId userId accessToken refreshToken idToken accessTokenExpiresAt refreshTokenExpiresAt scope password createdAt updatedAt',
  verification: 'id identifier value expiresAt createdAt updatedAt',
  allowlist: 'email added_at',
  resources: 'id owner_id name kind origin cpu gpu capabilities_json configured authenticated online usable heartbeat_at limits_json scope verification_json credits_json created_at node_id',
  grants: 'id resource_id owner_id grantee_id max_jobs max_tokens used_jobs used_tokens inference_only created_at revoked_at',
  key_verifiers: 'id owner_id name scope salt verifier prefix expires_at metadata created_at last_used_at revoked_at resource_id',
  jobs: 'id owner_id resource_id grant_id adapter model status tokens_in tokens_out cost_source created_at updated_at',
  usage: 'id owner_id kind requests tokens_in tokens_out model_cost_usd execution_cost_usd cost_source at',
  audit: 'id at actor_id action target detail',
  rateLimit: 'id key count lastRequest',
  write_budget: 'user_id window count',
  node_capabilities: 'node_id schema_version reported_at os arch runtimes_json mem_json disk_json workload_json',
  catalog_assets: 'id owner_id source repo revision kind task arch format quant license_json access manifest_json validation base_asset_id base_revision freshness_at created_at',
  catalog_asset_files: 'asset_id relpath bytes sha256',
  catalog_uploads: 'id owner_id state quotas_json manifest_json byte_ref expires_at created_at updated_at',
  catalog_compat_cache: 'cache_key principal fingerprint_json decision_json expires_at',
  catalog_deployments: 'id owner_id plan_json plan_fingerprint idem_key state node_id runtime error_json created_at updated_at',
  catalog_deployment_events: 'id deployment_id at from_state to_state detail',
  pairing_codes: 'id owner_id salt verifier created_at expires_at used_at attempts node_id resource_id',
  idempotency_keys: 'owner_id key resource_id created_at',
};

const federationSchema = {
  ...appSchema,
  resources: appSchema.resources + ' incarnation imported_from',
  key_verifiers: appSchema.key_verifiers + ' peer_node audience delegate',
  fabric_nodes: 'id owner_id workspace label fingerprint protocol transport issuer status node_secret_verifier node_secret_salt version created_at updated_at',
  invitations: 'id issuer_node recipient_node recipient_workspace purpose token_verifier token_salt state expiry use_record created_by created_at decided_at',
  connections: 'id a_node b_node a_workspace b_workspace state version created_by_invitation created_at updated_at suspended_by vetoed_by grant_gen',
  grant_previews: 'id connection_id canonical_json digest revision_vector expiry created_by created_at',
  approvals: 'id action target_id preview_id preview_digest revision_vector approver interaction_ref decision expiry consumed_at created_by created_at decided_at issued_connection issued_version issued_grant_gen bound_grant_id bound_grant_version consumed_by_op consumed_action consumed_target',
  fabric_grants: 'id connection_id recipient_node recipient_workspace consumers snapshot actions models ceilings route retention expiry status version preview_hash approval_id created_at updated_at exporter_id last_approval_id quarantine_reason',
  fabric_grant_revisions: 'id grant_id version terms_json approval_id superseded_at',
  fabric_denies: 'id owner_id principal resource_id action created_at',
  idempotency_records: 'idem_key actor method path request_hash status response_code response_body created_at attempt',
  connection_vetoes: 'connection_id side_node epoch added_at added_by',
  fabric_revision_receipts: 'operation_id grant_id approval_id actor_id request_hash approval_json before_version after_version before_json after_json applied_at',
  fabric_revision_failures: 'operation_id approval_id grant_id request_hash response_code response_body failed_at',
  fabric_operation_admissions: 'owner_id actor_kind idem_key method path request_hash admitted_at restriction',
  fabric_restriction_receipts: 'operation_id actor_id action target_id request_hash response_body applied_at',
};

function conjunction(parts) {
  if (parts.length === 1) return parts[0];
  const middle = Math.floor(parts.length / 2);
  return `(${conjunction(parts.slice(0, middle))} AND ${conjunction(parts.slice(middle))})`;
}

function probe(schema) {
  // Every identifier comes from the static contract above. Qualified column
  // references also prevent SQLite treating a missing quoted column as text.
  const columns = Object.entries(schema).flatMap(([table, names]) => names.split(' ').map(name => `"${table}"."${name}"`));
  // Keep the result one column wide (D1 limits result width). Column references
  // in WHERE validate the contract even though LIMIT 0 reads no rows.
  // Balance the predicates to stay below D1's expression-depth limit too.
  return `SELECT 1 FROM ${Object.keys(schema).map(table => `"${table}"`).join(', ')} WHERE ${conjunction(columns.map(column => column + ' IS NULL'))} LIMIT 0`;
}

const appProbe = probe(appSchema), federationProbe = probe(federationSchema);

export async function schemaReady(db, federationEnabled = false) {
  try {
    // One read-only statement resolves all required tables/columns at prepare
    // time. LIMIT 0 does not scan application data, even for the joined probe.
    const result = await db.prepare(federationEnabled ? federationProbe : appProbe).all();
    return result.success !== false;
  } catch {
    return false;
  }
}
