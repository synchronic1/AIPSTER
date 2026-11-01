# Licensing findings (2026-10-28)

Peter Medina explicitly chose Apache-2.0 and confirmed authority to license the
original AIPSTER/EIF worker files included here. His public GitHub account
`synchronic1` identifies him as Peter Medina; source commit author records match
that account. Authorship metadata is corroboration, not a substitute for that
explicit rights confirmation. Official Apache-2.0 text is in the root LICENSE
and vendor LICENSE; NOTICE records the grant and attribution.

The pinned EIF snapshot has no root LICENSE and none of the 16 copied files has
a copyright/SPDX/license notice. Its public visibility was not treated as a
license. This copy is licensed under the owner's explicit grant, without editing
or claiming to license the separate EIF repository. The 16-file allowlist and
individual hashes are in provenance.json. Ten files keep their original bytes.
`dendrite/api.py` and `dendrite/config.py` were modified by AIPSTER local patch 0001
(2026-10-28, security fix). `dendrite/fabric.py`, `dendrite/node.py`,
`dendrite/runtimes/base.py` and `dendrite/runtimes/llama.py` were modified by
AIPSTER local patch 0002 (2026-11-01, resident-only Ganglion fabric integration,
result job-id binding, rejection handling and attach-quarantine scoping).
As Apache-2.0 section 4(b) requires, each carries a
prominent change notice, and provenance.json records both the upstream and patched
hashes plus the patch itself.
Dependencies, third-party logos, native engines and model weights are excluded
from this project-owned license grant and keep their own terms.

## Official event evidence

Accessed 2026-10-28:

- [Official waiver/rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver).
  The rendered search view says Loading; the same public URL's HTML contains the
  complete official rules document in its server-rendered payload. That payload
  was extracted and preserved privately with the review evidence.
- [Submission portal named by the rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit).
  Anonymous access returns event information and Sign In links, not a submission
  form. Submission-only instructions, source-visibility fields or extra terms
  could not be verified. No access controls were bypassed.
- [Official event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon).

These are distinct obligations:

1. **Project source/license:** no particular project software license or general
   public-source requirement was found in the accessible official rules. That is
   not a claim about inaccessible submission-form requirements. Apache-2.0 is
   Peter's choice, not an asserted organizer mandate.
2. **Organizer rights:** the Materials provision gives broad continuing rights
   to use submitted materials; the submission IP provision retains entrant
   ownership while granting organizers broad non-exclusive exploitation rights.
   Those grants are not the project's software license.
3. **Third-party terms:** the originality/rights provision requires authority and
   non-infringement; third-party open source is allowed subject to its licenses.
   An organizer grant does not supersede dependency/model/brand restrictions.

No explicit conflict with Apache-2.0 was found in the accessible rules. Before
submission, the authorized participant must check the actual portal requirements
and only grant rights they possess. This is an evidence comparison, not a claim
that all future submission conditions have been cleared.

The local report records the exact source snapshot hashes and clause locations.
The official legal page is not redistributed in this source PR.

## Third-party components

No dependency source/wheels, native binary or model weights are committed. The
installer obtains pinned Python wheels with their original license metadata and
notices. `DEPENDENCIES.json` records installed distribution names/versions/license
metadata; those terms are not replaced by Apache-2.0. Any future bundled binary
distribution requires its own complete dependency/notice review.

Pinned IK source `3bb386eb68ffee0a5dc7db21da0735d594929eeb` has an MIT root license
crediting ggml, llama.cpp and ik_llama.cpp authors. Build/runtime dependencies
retain separate terms. Model licensing depends on the separately selected model.
