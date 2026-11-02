/* Demo acceptance: labels, honest reasons, no-network, no live claims,
 * plus the rendered outcomes match the real handlers' results. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTwoUserDemo, DEMO_LABEL, TRANSPORT } from '../demo/federation-two-user/run.mjs';
import { renderHtml } from '../demo/federation-two-user/render.mjs';

test('demo report carries synthetic labels and honest non-live reasons', async () => {
  const report = await runTwoUserDemo();
  assert.equal(report.label, DEMO_LABEL);
  assert.match(report.label, /SYNTHETIC\/FIXTURE/);
  assert.ok(report.transport.includes('no network') || report.transport.includes('No network') || TRANSPORT.includes('no '));
  assert.ok(report.sections.length >= 8, 'all outcome areas rendered');
  for (const s of report.sections) assert.match(s.label, /SYNTHETIC\/FIXTURE/, s.title);
  assert.match(report.notShownLive.heading, /NOT SHOWN LIVE/);
  assert.ok(report.notShownLive.reasons.length >= 3, 'absent outcomes carry reasons');
  assert.ok(report.notShownLive.liveTestPrerequisites.some(p => /Real user/i.test(p)), 'real-identity prerequisite stated');
  assert.ok(report.notShownLive.liveTestPrerequisites.some(p => /browser/i.test(p)), 'browser-pass prerequisite stated');
  assert.ok(report.flags.FEDERATION_ENABLED.includes('demo process only'), 'flag scope is honest');
});

test('demo outcomes equal the reviewed handlers’ real results', async () => {
  const report = await runTwoUserDemo();
  const by = Object.fromEntries(report.sections.map(s => [s.title, s]));
  assert.deepEqual(by['per-user fabric views'].aliceSees, ['alice-node']);
  assert.deepEqual(by['per-user fabric views'].bobSees, ['bob-node']);
  assert.equal(by['redacted peer node'].peerMine, false);
  assert.equal(by['redacted peer node'].peerLeaksSecrets, false);
  assert.equal(by['redacted peer node'].strangerStatus, 404);
  assert.equal(by['grant visibility incoming/outgoing'].bobIncomingHasGrant, true);
  assert.equal(by['grant visibility incoming/outgoing'].aliceOutgoingHasGrant, true);
  assert.equal(by['grant visibility incoming/outgoing'].thirdPartyStatus, 404);
  assert.equal(by['discovery via grant'].sharedFound, true);
  assert.equal(by['discovery via grant'].sharedVia, 'grant');
  assert.equal(by['routing-eligibility preview allow/deny'].grantedConsumer, 'allow');
  assert.equal(by['routing-eligibility preview allow/deny'].ungrantedConsumer, 'deny');
  assert.ok(by['per-owner quota exhaustion'].aliceAllowedBeforeBlock >= 1);
  assert.equal(by['per-owner quota exhaustion'].aliceBlockedStatus, 429);
  assert.equal(by['per-owner quota exhaustion'].bobStillAllowed, true);
  assert.equal(by['revocation effect'].revokeStatus, 200);
  assert.equal(by['revocation effect'].eligibilityAfter, 'deny');
  assert.equal(by['revocation effect'].stillDiscoveredViaGrant, false);
  assert.ok(by['audit rows present'].admissionCount >= 5);
  assert.equal(by['audit rows present'].allSessionActor, true);
});

test('rendered HTML labels every value and makes no live claims', async () => {
  const html = renderHtml(await runTwoUserDemo());
  assert.match(html, /SYNTHETIC\/FIXTURE/);
  assert.match(html, /NOT SHOWN LIVE/);
  assert.match(html, /no network|No network|in-process/);
  assert.match(html, /additionally need/);
  assert.doesNotMatch(html, /production grant|live peer|real user sharing|two-user sharing claim/i);
  assert.doesNotMatch(html, /<script/i, 'static markup only, no executable script');
});
