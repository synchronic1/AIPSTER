// Release-deploy gate: evaluates EVERY PR included in a release range,
// not just the newest merge, before any production step.
//
// Runs inside the deploy workflow on the trusted release checkout (a
// canonical-main tip) with full git history. It reads the holds file from
// that checkout (never candidate-controlled content), enumerates merge
// commits liveSha..targetSha with git, resolves each merge to its PRs via
// the API, binds each PR's evidence to its OWN head, proves integration
// via second-parent equality, then validates holds and merged-main CI at
// the target. Pure `evaluateDeployGate` takes injected git/request; the
// CLI runner below wires real git + fetch. No push/merge/deploy here.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CANONICAL_REPO, MAIN_CHECK_NAME, WORKER_CHECK_NAME,
  isWorkerApplicable} from './release-preflight.mjs';
import {bindEvidence, fetchAssociatedPRs, fetchPR,
  fetchPRFiles, fetchReviews, parseHoldsFile,
  requireCheckPass, resolveAcceptance, resolvePermissionsFor,
  resolveMaintainer, resolveReviewState, standingLogins, verifyCheckProducers,
  HOLD_REGISTRY_PATH, PINNED_OWNER,
  INSTALLER_CHECK_NAME, INSTALLER_WORKFLOW_FILE,
  SITE_WORKFLOW_FILE, WORKER_WORKFLOW_FILE} from './release-gate.mjs';

const SHA_RE = /^[a-f0-9]{40}$/;

// Historical release allowances (RELEASE158). Default OFF: an absent file
// or an empty `allowances` map changes nothing. An entry is a maintainer's
// explicit, auditable decision about named historical commits only — never
// a wildcard, never evidence, never automatic. It applies only when ALL of:
// manual mode; dispatch actor is the pinned owner; live equals the entry's
// pinned liveSha (so it is inert once live moves past it); exactly one PR
// in the range touched this file, its head blob equals the target blob,
// and that PR carries a maintainer review at its head naming
// `RELEASE-HISTORICAL-ALLOWANCE <id> <sha256 of the file>` (the dispatch
// shortcut never counts for this). Active holds, CI, producers, blocking
// reviews and integration proof are never relaxed by an allowance.
export const ALLOWANCE_PATH = '.github/release-historical-allowances.json';
export const ALLOWANCE_MARKER = 'RELEASE-HISTORICAL-ALLOWANCE';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function exactKeys(obj, keys, label) {
  assert(obj && typeof obj === 'object' && !Array.isArray(obj), `${label} must be an object`);
  const got = Object.keys(obj).sort();
  assert.deepEqual(got, [...keys].sort(), `${label} has missing or unknown keys`);
}

// Exact keys with an explicit optional set: absent optional keys keep the
// original shape byte-for-byte; unknown keys still refuse.
function exactKeysOpt(obj, keys, optional, label) {
  assert(obj && typeof obj === 'object' && !Array.isArray(obj), `${label} must be an object`);
  exactKeys(Object.fromEntries(Object.entries(obj).filter(([k]) => !optional.includes(k))), keys, label);
}

function shaList(list, label) {
  assert(Array.isArray(list) && list.length > 0, `${label} must be a non-empty list`);
  for (const s of list) assert(SHA_RE.test(s || ''), `${label} entries must be full 40-hex SHAs`);
  assert.equal(new Set(list).size, list.length, `${label} has duplicates`);
  return list;
}

export function parseAllowancesFile(json) {
  if (json === null || json === undefined) return {};
  exactKeys(json, ['version', 'allowances'], 'Allowance file');
  assert.equal(json.version, 1, 'Allowance file version must be 1');
  const out = {};
  for (const [id, e] of Object.entries(json.allowances || {})) {
    assert(ID_RE.test(id), `Allowance id ${id} is malformed`);
    exactKeysOpt(e, ['liveSha', 'mainBase', 'notAfter', 'registryTouches', 'supersededHeads',
      'decision', 'markerAuthor'], ['priorAllowanceMerges'], `Allowance ${id}`);
    assert(SHA_RE.test(e.liveSha || ''), `Allowance ${id} liveSha must be a full SHA`);
    // mainBase pins the exact main tip the allowance PR merges onto, so the
    // released range can never float to a later tip.
    assert(SHA_RE.test(e.mainBase || ''), `Allowance ${id} mainBase must be a full SHA`);
    // notAfter bounds re-use (e.g. re-dispatch after a production rollback).
    assert(typeof e.notAfter === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(e.notAfter)
      && Number.isFinite(Date.parse(e.notAfter)), `Allowance ${id} notAfter must be an ISO-8601 UTC timestamp`);
    // markerAuthor names who must post the activation marker. It is NOT an
    // approval record: only the marker review itself activates anything.
    assert.equal(e.markerAuthor, PINNED_OWNER, `Allowance ${id} markerAuthor must be the pinned owner`);
    assert(typeof e.decision === 'string' && e.decision.trim().length >= 20,
      `Allowance ${id} needs a written decision`);
    assert(Array.isArray(e.registryTouches), `Allowance ${id} registryTouches must be a list`);
    if (e.registryTouches.length) shaList(e.registryTouches, `Allowance ${id} registryTouches`);
    // Optional, exact: merges of EARLIER PRs in range that touched the
    // allowance file (a superseded allowance). Absent = exactly one toucher.
    if ('priorAllowanceMerges' in e) shaList(e.priorAllowanceMerges, `Allowance ${id} priorAllowanceMerges`);
    assert(Array.isArray(e.supersededHeads), `Allowance ${id} supersededHeads must be a list`);
    for (const s of e.supersededHeads) {
      exactKeysOpt(s, ['pr', 'head', 'merge', 'repairedBy', 'reason'], ['blockingReviews'],
        `Allowance ${id} superseded head`);
      // Optional, exact: native CHANGES_REQUESTED review objects at this
      // superseded head that the marker author (the same owner) records as
      // repaired by the chain because GitHub would not dismiss them. Only
      // the marker author's own reviews may be named.
      if ('blockingReviews' in s) {
        assert(Array.isArray(s.blockingReviews) && s.blockingReviews.length > 0,
          `Allowance ${id} PR ${s.pr} blockingReviews must be a non-empty list`);
        for (const b of s.blockingReviews) {
          exactKeys(b, ['id', 'by'], `Allowance ${id} PR ${s.pr} blocking review`);
          assert(Number.isSafeInteger(b.id) && b.id > 0, `Allowance ${id} PR ${s.pr} blocking review id invalid`);
          assert.equal(b.by, e.markerAuthor, `Allowance ${id} PR ${s.pr} may only name the marker author's own reviews`);
        }
        assert.equal(new Set(s.blockingReviews.map((b) => b.id)).size, s.blockingReviews.length,
          `Allowance ${id} PR ${s.pr} blockingReviews has duplicates`);
        assert(s.blockingReviews.every((b) => s.reason.includes(String(b.id))),
          `Allowance ${id} PR ${s.pr} reason must name every blocking review id`);
      }
      assert(Number.isSafeInteger(s.pr) && s.pr > 0, `Allowance ${id} superseded pr must be a number`);
      shaList([s.head, s.merge], `Allowance ${id} superseded head/merge`);
      assert(Array.isArray(s.repairedBy) && s.repairedBy.length > 0,
        `Allowance ${id} PR ${s.pr} needs a repair chain`);
      for (const r of s.repairedBy) {
        exactKeys(r, ['pr', 'head'], `Allowance ${id} repair`);
        assert(Number.isSafeInteger(r.pr) && r.pr !== s.pr, `Allowance ${id} repair pr invalid`);
        assert(SHA_RE.test(r.head || ''), `Allowance ${id} repair head must be a full SHA`);
      }
      assert(typeof s.reason === 'string' && s.reason.trim().length >= 20,
        `Allowance ${id} PR ${s.pr} needs a written reason`);
    }
    assert(e.registryTouches.length || e.supersededHeads.length,
      `Allowance ${id} allows nothing`);
    out[id] = e;
  }
  return out;
}

// Returns {id, entry} only when every activation condition holds; otherwise
// null with a recorded reason. Never throws for "not active": callers keep
// their original fail-closed refusal and add the reason to it.
export function activeAllowance({allowances, allowanceDigest, mode, dispatchActor,
  liveSha, targetSha, git, allowanceTouchers, permissions, now}) {
  const why = (reason) => { activeAllowance.lastReason = reason; return null; };
  const entries = Object.entries(allowances || {}).filter(([, e]) => e.liveSha === liveSha);
  if (entries.length === 0) return why('no allowance pinned to this live SHA');
  assert.equal(entries.length, 1, 'More than one allowance pinned to this live SHA (fail closed)');
  const [id, entry] = entries[0];
  if (mode !== 'manual') return why('allowances apply to manual dispatch only');
  if (dispatchActor !== PINNED_OWNER) return why('dispatch actor is not the pinned owner');
  if (!/^[a-f0-9]{64}$/.test(allowanceDigest || '')) return why('allowance file digest unavailable');
  let t;
  if (!entry.priorAllowanceMerges) {
    if (allowanceTouchers.length !== 1) {
      return why(`exactly one PR in range must introduce ${ALLOWANCE_PATH} (found ${allowanceTouchers.length})`);
    }
    [t] = allowanceTouchers;
  } else {
    // Replacement allowance: the activating PR is the target's own merge;
    // every other toucher must be exactly the named prior merges.
    t = allowanceTouchers.find((x) => x.merge === targetSha);
    const others = allowanceTouchers.filter((x) => x !== t).map((x) => x.merge).sort();
    if (!t || others.join() !== [...entry.priorAllowanceMerges].sort().join()) {
      return why(`${ALLOWANCE_PATH} touchers must be the target PR plus exactly ${entry.priorAllowanceMerges.join(', ')} (found ${allowanceTouchers.map((x) => x.merge).join(', ') || 'none'})`);
    }
  }
  if (!(Number.isFinite(now) && now <= Date.parse(entry.notAfter))) {
    return why(`allowance ${id} expired at ${entry.notAfter} (or clock unavailable)`);
  }
  // Exact target binding: the release target must be the merge commit of
  // the single introducing PR, onto the pinned main tip, integrating that
  // PR's head. A later tip, another base, or any other commit never
  // activates the allowance.
  if (targetSha !== t.merge) {
    return why(`target ${targetSha} is not PR ${t.number} merge ${t.merge}`);
  }
  if (git.firstParent(targetSha) !== entry.mainBase) {
    return why(`target first parent is not the pinned mainBase ${entry.mainBase}`);
  }
  if (git.secondParent(targetSha) !== t.head) {
    return why(`target second parent is not PR ${t.number} head ${t.head}`);
  }
  // The merge itself must not change the hold registry: registry content at
  // the target equals the pinned mainBase (closes a change made inside the
  // merge commit, which a --no-merges touch listing cannot see).
  const baseRegistry = git.blobAt(entry.mainBase, HOLD_REGISTRY_PATH);
  if (!baseRegistry || git.blobAt(targetSha, HOLD_REGISTRY_PATH) !== baseRegistry) {
    return why(`target ${HOLD_REGISTRY_PATH} differs from mainBase (merge must not change the registry)`);
  }
  const headBlob = git.blobAt(t.head, ALLOWANCE_PATH);
  const targetBlob = git.blobAt(targetSha, ALLOWANCE_PATH);
  if (!headBlob || headBlob !== targetBlob) {
    return why(`PR ${t.number} head blob of ${ALLOWANCE_PATH} differs from the target`);
  }
  const marker = `${ALLOWANCE_MARKER} ${id} ${allowanceDigest}`;
  // Only the named marker author (the pinned owner) can activate; another
  // maintainer's marker never counts.
  const ok = (t.reviews || []).some((r) => (r.state === 'APPROVED' || r.state === 'COMMENTED')
    && r.commitId === t.head && typeof r.body === 'string' && r.body.includes(marker)
    && r.user === entry.markerAuthor
    && resolveMaintainer({login: r.user, association: r.association,
      permission: permissions?.[r.user]}).maintainer);
  if (!ok) return why(`PR ${t.number} lacks a maintainer review by ${entry.markerAuthor} at ${t.head} naming "${marker}"`);
  return {id, entry};
}

export async function evaluateDeployGate({git, request, fetchChecks,
  fetchHeadChecks, liveSha, targetSha, mode, dispatchActor,
  dispatchActorAssociation, holds, permissions,
  allowances = {}, allowanceDigest = null, now = Date.now()}) {
  assert(SHA_RE.test(liveSha || ''), 'An exact live SHA is required');
  assert(SHA_RE.test(targetSha || ''), 'An exact target SHA is required');
  assert(mode === 'auto' || mode === 'manual', 'Mode must be auto or manual');
  if (liveSha === targetSha) return {ok: true, noop: 'already-live'};
  assert(holds && typeof holds === 'object', 'Trusted holds map is required');
  // Entire first-parent live..target range is inspected. Regular
  // (non-merge) commits — direct pushes, squash or rebase content — are
  // UNSUPPORTED by this initial evaluator and always refused: ancestry in
  // a later branch proves nothing about review coverage, and no
  // association equivalence is invented for them. Remote merge methods are
  // NOT changed; such content simply cannot release here (a strict
  // merge-base refinement is a documented later option, not this gate).
  const range = git.commitsInRange(liveSha, targetSha);
  assert(Array.isArray(range) && range.length > 0,
    'Empty range without equality: refetch main (fail closed)');
  const evaluated = [];
  // Superseded-head candidates are DEFERRED, not accepted: they are only
  // resolved after the whole range is evaluated and the allowance is proven
  // active. Any other evidence failure throws immediately, as before.
  const deferred = [];
  const allowanceTouchers = [];
  const supersededEntry = (pr, merge) => {
    for (const [id, e] of Object.entries(allowances || {})) {
      for (const s of e.supersededHeads) {
        if (s.pr === pr.number && s.head === pr.headSha && s.merge === merge) return {id, s};
      }
    }
    return null;
  };
  for (const sha of range) {
    assert(SHA_RE.test(sha || ''), 'Range returned a non-SHA');
    const second = git.secondParent(sha);
    assert(second !== null,
      `Unbound mainline commit ${sha}: direct/squash/rebase content is unsupported by this evaluator (no remote methods changed; this content cannot release)`);
    const associated = await fetchAssociatedPRs(request, sha);
    assert(associated.length > 0,
      `Merge ${sha} has no associated pull request to canonical main`);
    for (const assoc of associated) {
      assert(assoc.base?.ref === 'main'
        && assoc.base?.repo?.full_name === CANONICAL_REPO,
        `Associated PR for ${sha} is not merged to canonical main`);
      const pr = await fetchPR(request, assoc.number ?? assoc.id);
      const reviews = await fetchReviews(request, pr.number);
      // Fresh standing first: acceptance authors, same-head blocking
      // authors, and structured-evidence publishers (supported endpoint
      // reads, fail-closed gaps). Fresh reads take precedence over the
      // caller map: caller booleans can be stale, never authoritative.
      // Evidence binding below needs the fresh map — a proved outsider's
      // body must be ignorable before anything is parsed.
      const fresh = await resolvePermissionsFor({request,
        logins: standingLogins(reviews, pr.headSha)});
      permissions = {...(permissions || {}), ...fresh};
      let evidence;
      try {
        evidence = bindEvidence({pr, reviews, permissions});
      } catch (err) {
        const hit = supersededEntry(pr, sha);
        // Name the refused PR/head: the raw bind error alone (as seen in
        // run 41898734744) leaves the blocker unidentified. Behavior
        // unchanged — still throws for non-superseded heads.
        if (!hit) throw new Error(`PR ${pr.number} head ${pr.headSha}: ${err && err.message || err}`);
        deferred.push({number: pr.number, head: pr.headSha, merge: sha, ...hit,
          evidenceError: String(err && err.message || err)});
        evidence = [];
      }
      assert(second === pr.headSha,
        `Merge ${sha} does not integrate reviewed head ${pr.headSha}`);
      const acceptance = resolveAcceptance({reviews: reviews,
        headSha: pr.headSha, permissions, dispatchActor,
        dispatchActorAssociation});
      assert(acceptance,
        `No maintainer acceptance for PR ${pr.number} head ${pr.headSha}`);
      // Acceptance does not erase blocking: an unresolved same-head
      // CHANGES_REQUESTED or structured HOLD refuses this PR too.
      let state = resolveReviewState({reviews, headSha: pr.headSha,
        permissions});
      // Exact-review deferral: only a native changes-requested object that
      // a superseded-head entry names (id AND author = marker author). The
      // state is recomputed without that one object, so any other block
      // still refuses; the deferral resolves only if the allowance is
      // proven active and the repair chain carries its own evidence.
      const blockedHit = state.blocked && state.blocked.via === 'changes-requested'
        ? supersededEntry(pr, sha) : null;
      const named = blockedHit && (blockedHit.s.blockingReviews || []).find((b) =>
        b.id === state.blocked.reviewId && b.by === state.blocked.by
        && b.by === allowances[blockedHit.id].markerAuthor);
      if (named) {
        const rest = resolveReviewState({reviews: reviews.filter((r) => r.id !== named.id),
          headSha: pr.headSha, permissions});
        if (!rest.blocked) {
          let d = deferred.find((x) => x.number === pr.number && x.merge === sha);
          if (!d) {
            d = {number: pr.number, head: pr.headSha, merge: sha, ...blockedHit,
              evidenceError: `unresolved changes-requested by ${named.by} (review ${named.id})`};
            deferred.push(d);
          }
          d.deferredReview = {id: named.id, by: named.by};
          state = rest;
        }
      }
      assert(!state.blocked,
        `PR ${pr.number} has unresolved ${state.blocked?.via} by ${state.blocked?.by} at head ${pr.headSha} (review ${state.blocked?.reviewId})`);
      // Per-PR head CI: the installer workflow is PR-only, so installer
      // results exist only at the head — re-verify them here rather than
      // trusting target CI alone. Merged-main CI below covers site plus
      // conditional worker only (installer at a merge target would
      // deadlock every deploy: verified requirement asymmetry, kept).
      assert(typeof fetchHeadChecks === 'function',
        'Per-PR head check fetcher is required (no silent target-only CI)');
      const headChecks = await fetchHeadChecks(pr.headSha);
      requireCheckPass(headChecks, MAIN_CHECK_NAME, pr.headSha,
        `PR ${pr.number} head`);
      const files = await fetchPRFiles(request, pr.number);
      const headWorker = isWorkerApplicable(files);
      if (headWorker) {
        requireCheckPass(headChecks, WORKER_CHECK_NAME, pr.headSha,
          `PR ${pr.number} head touches worker-covered paths, so`);
        requireCheckPass(headChecks, INSTALLER_CHECK_NAME, pr.headSha,
          `PR ${pr.number} head touches worker-covered paths, so its`);
      }
      // Producer binding for the same per-PR checks: passing runs must
      // come from their expected workflow files.
      const headSpecs = [{name: MAIN_CHECK_NAME, sha: pr.headSha,
        workflowFile: SITE_WORKFLOW_FILE, label: `PR ${pr.number} head`}];
      if (headWorker) {
        headSpecs.push({name: WORKER_CHECK_NAME, sha: pr.headSha,
          workflowFile: WORKER_WORKFLOW_FILE,
          label: `PR ${pr.number} head worker suite`},
        {name: INSTALLER_CHECK_NAME, sha: pr.headSha,
          workflowFile: INSTALLER_WORKFLOW_FILE,
          label: `PR ${pr.number} head installer suite`});
      }
      await verifyCheckProducers({request, checks: headChecks,
        specs: headSpecs});
      if (files.includes(ALLOWANCE_PATH)) {
        allowanceTouchers.push({number: pr.number, head: pr.headSha, merge: sha, reviews});
      }
      evaluated.push({merge: sha, number: pr.number, head: pr.headSha,
        evidence: evidence.length, acceptedBy: acceptance.by, via: acceptance.via});
    }
  }
  assert(evaluated.length > 0,
    'No merge with bound PR evidence in range: unassociated main pushes cannot release');
  // The range aggregate is computed once: it drives BOTH the hold-registry
  // guard below and worker conditionality. A range touching the control
  // file fails closed however it touches it (modify/remove/replace) —
  // history is preserved by refusing, never by rewriting it — UNLESS an
  // active historical allowance names exactly the touching commits.
  const changed = git.changedFiles(liveSha, targetSha);
  const used = [];
  // Resolve at most one active allowance. Nothing below runs (and nothing
  // is relaxed) unless the range actually needs it.
  const needsAllowance = deferred.length > 0 || changed.includes(HOLD_REGISTRY_PATH);
  let active = null;
  let inactiveReason = '';
  if (needsAllowance) {
    activeAllowance.lastReason = '';
    active = activeAllowance({allowances, allowanceDigest, mode, dispatchActor,
      liveSha, targetSha, git, allowanceTouchers, permissions, now});
    inactiveReason = active ? '' : ` [allowance inactive: ${activeAllowance.lastReason}]`;
  }
  if (changed.includes(HOLD_REGISTRY_PATH)) {
    // Default path is byte-for-byte the original refusal: no listing, no
    // relaxation, unless an allowance is proven active.
    assert(active,
      `Release range touches the hold registry (${HOLD_REGISTRY_PATH}): refused — clearance needs a separately approved owner operation${inactiveReason}`);
    const touches = git.registryTouches(liveSha, targetSha, HOLD_REGISTRY_PATH);
    assert(Array.isArray(touches), 'Registry touch listing failed (fail closed)');
    const pinned = active ? active.entry.registryTouches : [];
    const same = active && touches.length === pinned.length
      && [...touches].sort().join() === [...pinned].sort().join();
    assert(same,
      `Release range touches the hold registry (${HOLD_REGISTRY_PATH}): refused — clearance needs a separately approved owner operation`
      + (active ? ` (allowance ${active.id} pins ${pinned.length} touch(es); range has ${touches.length}: ${touches.join(', ')})` : inactiveReason));
    used.push({allowance: active.id, registryTouches: touches});
  }
  for (const d of deferred) {
    assert(active && active.id === d.id,
      `PR ${d.number} head ${d.head}: ${d.evidenceError}${inactiveReason || ' (allowance does not cover this head)'}`);
    for (const r of d.s.repairedBy) {
      const repaired = evaluated.find((p) => p.number === r.pr && p.head === r.head);
      assert(repaired && repaired.evidence > 0,
        `PR ${d.number} repair PR ${r.pr} head ${r.head} is not merged in this range with its own bound evidence`);
    }
    used.push({allowance: d.id, supersededHead: {pr: d.number, head: d.head,
      repairedBy: d.s.repairedBy,
      ...(d.deferredReview ? {deferredBlockingReview: d.deferredReview} : {})}});
  }
  // Fresh trusted hold governs before any production step: any active
  // GLOBAL hold, or any active hold on an ancestor-or-self of the target
  // (proven by git, never assumed), blocks both paths. A descendant
  // release with an UNCHANGED registry stays held. Unknown git outcomes
  // throw (fail closed).
  const covering = [];
  for (const hold of Object.values(holds)) {
    if (!hold || !hold.active) continue;
    if (hold.blockMerges === true) { covering.push(hold); continue; }
    if (hold.sha === targetSha) { covering.push(hold); continue; }
    if (git.isAncestor(hold.sha, targetSha)) covering.push(hold);
  }
  assert(covering.length === 0,
    `Release HOLD active: ${covering.map(h => h.sha + ' (' + h.reason + ')').join(', ')}`);
  const checks = await fetchChecks(targetSha);
  requireCheckPass(checks, MAIN_CHECK_NAME, targetSha, 'The release revision');
  const targetWorker = isWorkerApplicable(changed);
  if (targetWorker) {
    requireCheckPass(checks, WORKER_CHECK_NAME, targetSha,
      'The release touches worker-covered paths, so');
  }
  // Producer binding for the merged-main checks as well.
  const targetSpecs = [{name: MAIN_CHECK_NAME, sha: targetSha,
    workflowFile: SITE_WORKFLOW_FILE, label: 'The release revision'}];
  if (targetWorker) {
    targetSpecs.push({name: WORKER_CHECK_NAME, sha: targetSha,
      workflowFile: WORKER_WORKFLOW_FILE,
      label: 'The release worker suite'});
  }
  await verifyCheckProducers({request, checks, specs: targetSpecs});
  return {ok: true, mode, live: liveSha, target: targetSha, prs: evaluated,
    historicalAllowances: used,
    residualRace: 'Recheck main immediately before the irreversible step.'};
}

// Real git wrapper (exported for offline testing on tiny repositories).
// Exit codes are HONEST: merge-base exit 1 means proven non-ancestry and
// returns false; any other failure (missing objects, corruption —
// typically exit 128) THROWS so unknown git outcomes fail closed and a
// hold can never vanish on a read error. rev-parse ^2 on a non-merge
// commit fails and yields null, which marks the commit as regular.
export function realGit(cwd) {
  const run = (args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
  return {
    commitsInRange: (live, target) =>
      run(['log', '--format=%H', '--first-parent', `${live}..${target}`])
        .split('\n').map(s => s.trim()).filter(Boolean),
    firstParent: (sha) => {
      try {
        return run(['rev-parse', `${sha}^1`]);
      } catch {
        return null;
      }
    },
    secondParent: (merge) => {
      try {
        return run(['rev-parse', `${merge}^2`]);
      } catch {
        return null;
      }
    },
    isAncestor: (a, b) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', a, b], {cwd});
        return true;
      } catch (e) {
        if (e && e.status === 1) return false;
        throw new Error(`Ancestry unknown for ${a}..${b}: git exit ${e && e.status}`);
      }
    },
    changedFiles: (live, target) =>
      run(['diff', '--name-only', live, target]).split('\n')
        .map(s => s.trim()).filter(Boolean),
    // Every commit (all parents, not first-parent) in live..target that
    // touched `path`: the exact set an allowance must pin.
    registryTouches: (live, target, path) =>
      run(['log', '--format=%H', '--full-history', '--no-merges', `${live}..${target}`, '--', path]).split('\n')
        .map(s => s.trim()).filter(Boolean),
    // Blob id of `path` at `sha`, or null when absent.
    blobAt: (sha, path) => {
      try {
        return run(['rev-parse', `${sha}:${path}`]);
      } catch {
        return null;
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const liveSha = process.env.LIVE_SHA;
  const targetSha = process.env.TARGET_SHA;
  const mode = process.env.RELEASE_MODE === 'manual' ? 'manual' : 'auto';
  assert.equal(process.env.GITHUB_REPOSITORY, CANONICAL_REPO);
  assert(process.env.GH_TOKEN, 'GitHub read credential is required');
  const {readFile: read} = await import('node:fs/promises');
  const holds = parseHoldsFile(JSON.parse(
    await read(resolve(root, '.github/release-holds.json'), 'utf8')));
  // Optional trusted allowance file (default off when absent). Its sha256
  // must appear in the maintainer's allowance review; read from the same
  // trusted release checkout as the holds, never from candidate content.
  let allowances = {};
  let allowanceDigest = null;
  let allowanceRaw = null;
  try {
    allowanceRaw = await read(resolve(root, ALLOWANCE_PATH));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  if (allowanceRaw) {
    const {createHash} = await import('node:crypto');
    allowanceDigest = createHash('sha256').update(allowanceRaw).digest('hex');
    allowances = parseAllowancesFile(JSON.parse(allowanceRaw.toString('utf8')));
  }
  async function api(path) {
    const res = await fetch(`https://api.github.com/repos/${CANONICAL_REPO}/${path}`, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'},
      signal: AbortSignal.timeout(15000), redirect: 'error'});
    assert(res.ok, `Metadata API returned HTTP ${res.status} for ${path}`);
    return res.json();
  }
  const {fetchCheckRunsAll} = await import('./release-gate.mjs');
  const fetchHeadChecks = (sha) => fetchCheckRunsAll(api, sha);
  // Best-effort standing for the dispatch actor: the read token usually
  // cannot read collaborator permission (fail closed to the pinned owner /
  // OWNER association inside resolveAcceptance via permissions map gaps).
  let permissions;
  if (process.env.DISPATCH_ACTOR) {
    try {
      const data = await api(`collaborators/${process.env.DISPATCH_ACTOR}/permission`);
      if (data && typeof data.permission === 'string') {
        permissions = {[process.env.DISPATCH_ACTOR]: data.permission};
      }
    } catch {
      permissions = undefined;
    }
  }
  const verdict = await evaluateDeployGate({git: realGit(root), request: api,
    fetchChecks: (sha) => fetchCheckRunsAll(api, sha),
    fetchHeadChecks, liveSha,
    targetSha, mode, dispatchActor: process.env.DISPATCH_ACTOR || null,
    dispatchActorAssociation: null, holds, permissions, allowances, allowanceDigest});
  console.log(JSON.stringify(verdict));
}
