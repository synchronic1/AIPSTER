/* Built with Meta Muse. */
// Admin scaffold shell: same-origin reads only. The shell renders whatever
// availability state the server reports and invents no data — an unknown or
// missing field is shown as unknown, never as zero or healthy.
'use strict';

async function loadStatus() {
  const grant = document.getElementById('grant');
  try {
    const res = await fetch('/api/admin/v1/status', { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.grant) {
      grant.textContent = 'Authorized as ' + body.grant.role + ' (scope ' + body.grant.scope + '). '
        + 'Elevation: ' + (body.elevation || 'unknown') + '. Mutations: ' + (body.mutations || 'unknown') + '.';
    } else if (body && body.code) {
      grant.textContent = 'Not authorized (' + body.code + '). Sign in with an administration grant.';
    } else {
      grant.textContent = 'Authorization unknown (HTTP ' + res.status + ').';
    }
  } catch {
    grant.textContent = 'Authorization unknown (request failed).';
  }
}

async function loadSection(section, endpoint) {
  const state = section.querySelector('.state');
  state.textContent = 'Loading…';
  try {
    const res = await fetch(endpoint, { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (res.ok && body) {
      const parts = ['state: ' + (body.state === null || body.state === undefined ? 'unknown' : body.state)];
      if (body.reason_code) parts.push('reason: ' + body.reason_code);
      if (body.metric) parts.push('metric: ' + body.metric);
      if (Array.isArray(body.items)) parts.push('items: ' + body.items.length + ' (total ' + (body.total === null ? 'unknown' : body.total) + ')');
      state.textContent = parts.join(', ') + '.';
    } else if (body && body.code) {
      state.textContent = 'Unavailable: ' + body.code + ' (HTTP ' + res.status + ').';
    } else {
      state.textContent = 'Unavailable: HTTP ' + res.status + '.';
    }
  } catch {
    state.textContent = 'Unavailable: request failed.';
  }
}

document.querySelectorAll('button[data-endpoint]').forEach((button) => {
  button.addEventListener('click', () => {
    const section = button.closest('section');
    if (section) loadSection(section, button.getAttribute('data-endpoint'));
  });
});

loadStatus();
