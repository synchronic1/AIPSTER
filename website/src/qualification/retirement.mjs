/* Built with Meta Muse. */
// These rows are private retention evidence, never replay or active state.
// Copy the records and remove their live FK references in the caller's same
// owned resource teardown batch. qualification_spend is intentionally not
// touched; a retired in-flight op keeps its existing charge/reservation.
const facts = [
  {
    table: 'qualification_recommendations', kind: 'recommendation', key: 'q.op_key', state: 'q.state',
    disposition: "CASE WHEN q.state IN ('reserved','fetching','uncertain') THEN 'outcome-uncertain' ELSE 'historical' END",
    cols: ['owner_id','node_id','profile_digest','catalog_version','prompt_version','mode','op_key','input_digest','state','advice_json','receipt_json','created_at','updated_at'],
  },
  {
    table: 'qualification_cache', kind: 'cache',
    key: 'json_array(q.profile_digest,q.catalog_version,q.prompt_version,q.mode)', state: "'cached'", disposition: "'historical'",
    cols: ['owner_id','node_id','profile_digest','catalog_version','prompt_version','mode','advice_json','receipt_json','created_at','updated_at'],
  },
  {
    table: 'qualification_runs', kind: 'run', key: 'q.run_id', state: 'q.state',
    disposition: "CASE WHEN q.state='assigned' THEN 'assignment-closed' WHEN q.state IN ('leased','uncertain') THEN 'outcome-uncertain' ELSE 'historical' END",
    cols: ['run_id','owner_id','node_id','profile_digest','catalog_version','catalog_id','lease_id','state','mode','claim_by','execution_deadline','assignment_json','result_json','created_at','updated_at'],
  },
];

export function qualificationRetirementStatements(db, node, owner, at) {
  // The parent existence check applies to every dependent row while the
  // parent still exists. A legacy mismatched owner, if present, is retained
  // under its own historical owner rather than attributed to the caller.
  const owned = 'EXISTS(SELECT 1 FROM resources r JOIN "user" u ON u.id=r.owner_id WHERE r.id=? AND r.owner_id=? AND u.disabled=0)';
  return [
    ...facts.map(f => db.prepare(`INSERT INTO qualification_retired_records(owner_id,node_id,kind,record_key,prior_state,disposition,record_json,retired_at)
      SELECT q.owner_id,q.node_id,'${f.kind}',${f.key},${f.state},${f.disposition},
        json_object(${f.cols.map(x => "'"+x+"',q."+x).join(',')}),?
      FROM ${f.table} q WHERE q.node_id=? AND ${owned}`).bind(at,node,node,owner)),
    ...facts.map(f => db.prepare(`DELETE FROM ${f.table} WHERE node_id=? AND ${owned}`).bind(node,node,owner)),
  ];
}
