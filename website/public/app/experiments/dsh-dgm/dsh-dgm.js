/* Loader for the /app/experiments/dsh-dgm/ page.
 *
 * The panel shell policy allows exactly one same-origin script per shell and
 * no other script attributes, so this stays a classic script: the experiment
 * modules are pulled in with dynamic import only after the administrator
 * authorization check has answered. The modules are unchanged copies of the
 * independently reviewed export; this file adds no authority and can only
 * decide whether they load.
 *
 * The check is the existing read-only administration gate, GET
 * /api/admin/v1/status, which authorizes a live platform grant server-side.
 * A signed-in non-admin, a demo account, a revoked or expired grant and an
 * API-key caller are refused there, not here. These page assets are public
 * static files like every other panel shell; the server response governs what
 * this page renders, it does not make the files secret.
 */
(function () {
  'use strict';

  var GATE_MODULE = '/app/experiments/dsh-dgm/admin-gate.mjs';
  var DEMO_MODULE = '/app/experiments/dsh-dgm/src/demo.mjs';
  var ENDPOINT = '/api/admin/v1/status';

  var panel = document.getElementById('access-gate');
  var message = document.getElementById('access-message');
  var host = document.getElementById('experiment');

  if (!panel || !message || !host) return;

  function deny(state, text) {
    host.hidden = true;
    panel.hidden = false;
    message.dataset.state = state;
    message.textContent = text;
  }

  function allow(text) {
    message.dataset.state = 'authorized';
    message.textContent = text;
    panel.hidden = true;
    host.hidden = false;
  }

  (async function start() {
    var decideAdminAccess;
    try {
      decideAdminAccess = (await import(GATE_MODULE)).decideAdminAccess;
    } catch (error) {
      deny('unavailable', 'The authorization check could not be loaded, so the interactive experiment did not run.');
      return;
    }

    var status = 0;
    var payload = null;
    var failure = null;

    try {
      var response = await fetch(ENDPOINT, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      });
      status = response.status;
      try {
        payload = await response.json();
      } catch (error) {
        // A body we could not parse is a check we could not complete, not an
        // authorization. Leave payload null and record the reason.
        failure = 'unreadable response';
      }
    } catch (error) {
      failure = 'request failed';
    }

    var decision = decideAdminAccess({ status: status, payload: payload, error: failure });
    if (!decision.load) {
      deny(decision.state, decision.message);
      return;
    }

    try {
      await import(DEMO_MODULE);
    } catch (error) {
      deny('unavailable', 'The experiment modules did not load, so nothing ran.');
      return;
    }

    allow(decision.message);
  })();
})();
