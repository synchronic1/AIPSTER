# AIPSTER agent and contributor instructions

## Testing policy (current sprint)

Risk-based validation: match evidence to the change, and stop once the
required evidence is sufficient.

- Per fix, run the original repro and the affected tests first.
- Reuse passing evidence when the relevant source, dependencies, tests and
  environment are unchanged; record the commit/source identity it covers.
- Assertion-only expected-SHA edits: verify the pin against the reviewed
  source and run the affected UI test. Actual runtime or dependency pin
  changes require the affected integration checks.
- Auth, shared transaction/admission/retry logic, schema, shared libraries
  or dependency changes require the applicable broader security, concurrency
  and real-D1 checks.
- Run the relevant full integration suite on the final combined candidate.
  Repeat only after a material invalidating change, a failure, or an
  unresolved concern.
- Do not duplicate in-flight suites or reviews, repeatedly poll stale jobs,
  or spawn agents to redo completed analysis. Independent work may run in
  parallel with clear ownership (one owner per branch).
- Required GitHub checks still apply. Never skip, weaken or fabricate safety
  or review evidence.

### Final handoff

Each validation round ends with a short handoff: exact candidate SHA,
evidence reused, new checks and results, concrete blockers, and a READY or
HOLD verdict.

CI automation of this policy is deferred to a separately reviewed follow-up
after this sprint.
