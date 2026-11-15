-- App grant uniqueness and qualification teardown history.
-- Retire only duplicate active rows; individual revoked grants, charges, and
-- refund/dispatch references keep their existing IDs. A retained active row
-- must still match the current resource owner and sandbox; its allowance may
-- not exceed the most restrictive remaining allowance among its old peers.
CREATE TABLE _grant_reconciliation_0032 (
  grant_id TEXT PRIMARY KEY,
  keep_id TEXT,
  max_jobs INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  keep_job_limit INTEGER NOT NULL,
  keep_token_limit INTEGER NOT NULL
);

INSERT INTO _grant_reconciliation_0032
WITH refunded AS (
  SELECT grant_id, SUM(jobs) AS jobs, SUM(tokens) AS tokens FROM routing_refunds GROUP BY grant_id
), active AS (
  SELECT g.*,
    MAX(0,g.used_jobs-COALESCE(f.jobs,0)) AS net_jobs,
    MAX(0,g.used_tokens-COALESCE(f.tokens,0)) AS net_tokens,
    CASE WHEN g.owner_id=r.owner_id AND o.demo=u.demo THEN 1 ELSE 0 END AS valid
  FROM grants g
  JOIN resources r ON r.id=g.resource_id
  JOIN "user" o ON o.id=g.owner_id
  JOIN "user" u ON u.id=g.grantee_id
  LEFT JOIN refunded f ON f.grant_id=g.id
  WHERE g.revoked_at IS NULL
), ranked AS (
  SELECT *,
    FIRST_VALUE(CASE WHEN valid=1 THEN id END) OVER choice AS keep_id,
    COUNT(*) OVER members AS n,
    MIN(MAX(0,max_jobs-net_jobs)) OVER members AS jobs_left,
    MIN(MAX(0,max_tokens-net_tokens)) OVER members AS tokens_left
  FROM active
  WINDOW members AS (PARTITION BY resource_id,grantee_id),
    choice AS (PARTITION BY resource_id,grantee_id ORDER BY valid DESC,created_at,id)
)
SELECT id,keep_id,max_jobs,max_tokens,MIN(max_jobs,net_jobs+jobs_left),MIN(max_tokens,net_tokens+tokens_left)
FROM ranked WHERE n>1;

UPDATE grants
SET max_jobs=(SELECT keep_job_limit FROM _grant_reconciliation_0032 WHERE grant_id=grants.id),
    max_tokens=(SELECT keep_token_limit FROM _grant_reconciliation_0032 WHERE grant_id=grants.id),
    inference_only=1
WHERE id IN (SELECT grant_id FROM _grant_reconciliation_0032 WHERE grant_id=keep_id);

UPDATE grants
SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE revoked_at IS NULL AND id IN (
  SELECT grant_id FROM _grant_reconciliation_0032 WHERE keep_id IS NULL OR grant_id<>keep_id
);

INSERT INTO audit(id,at,actor_id,action,target,detail)
SELECT 'migration:0032:grant:' || x.grant_id, COALESCE(g.revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),NULL,
  CASE WHEN x.grant_id=x.keep_id THEN 'grant.duplicate_reconciled' ELSE 'grant.duplicate_retired' END,
  x.grant_id, json_object('survivor',x.keep_id,'previousMaxJobs',x.max_jobs,'previousMaxTokens',x.max_tokens,
                        'retainedMaxJobs',g.max_jobs,'retainedMaxTokens',g.max_tokens)
FROM _grant_reconciliation_0032 x JOIN grants g ON g.id=x.grant_id;

DROP TABLE _grant_reconciliation_0032;

CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_active_resource_grantee
ON grants(resource_id,grantee_id) WHERE revoked_at IS NULL;

-- No reference to removed resources. These are owner-bound, internal audit
-- artifacts, not current recommendations, caches, replay targets, or jobs.
-- Existing, sanitized receipts remain intact; the retention disposition is
-- separate so unsettled work is not claimed completed or refunded.
CREATE TABLE IF NOT EXISTS qualification_retired_records (
  owner_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('recommendation','cache','run')),
  record_key TEXT NOT NULL,
  prior_state TEXT NOT NULL,
  disposition TEXT NOT NULL,
  record_json TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,node_id,kind,record_key)
);
CREATE INDEX IF NOT EXISTS idx_qual_retired_recommendation_key
ON qualification_retired_records(owner_id,record_key) WHERE kind='recommendation';
