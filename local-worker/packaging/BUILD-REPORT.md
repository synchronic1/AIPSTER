<!-- Built with Meta Muse; isolated Codex review and repair evidence below. -->
# Windows worker build report

## Native ownership follow-up

Diagnostic CI run40935794359/job123665871201 confirmed the elevated runner's
new paths have owner and token-default-owner S-1-5-32-544, distinct from its
user SID; the old strict helper rejected them before writing any token.
The native helper normalizes only exclusively created paths, retains
existing-foreign-owner denial, verifies the exact protected user-only DACL
and avoids the measured 23-35s PowerShell startup cost. All16 source tests
pass locally in0.209s. Lead independent review passed5 additional native
cases and4 retained installer cases. New frozen build/elevated CI evidence
is pending; the artifact below belongs to the preceding source.

## Earlier repaired artifact (local, unsigned, unpublished)

| Field | Value |
|---|---|
| Artifact | `AIPSTER-Worker-0.1.0-win64-setup.exe` |
| Size | 13,083,766 bytes |
| SHA-256 | `ecd0bec316981acb251da566253abc4b65e2f8c56aa41a9fc1165c52555a40e7` |
| Built from | `a2ec5e1938436e48de091548aa37f151cf8109e4`, clean tree (`source_dirty=false`) |
| Payload | 98 files; complete hashes in generated `dist/manifest.json` |
| Worker | ganglion-dendrite 0.1.0; original vendor tree and patches verified unchanged |
| Toolchain | CPython 3.12.14, uv 0.12.12, NSIS 3.13, PyInstaller 6.22.3 |
| CPython notice | 25,066 bytes; SHA-256 `886a0ead2d89030ee62dbff52b04e47ab91998341295bb9c56fb952b4e081c7a` |

The manifest/checksums and artifact are local build outputs, not a release.
The release owner must rebuild from the eventual merge commit, re-qualify,
then publish and wire that exact verified artifact. Dashboard hashes from
earlier source commits are historical and must not identify this repair.

## Review and repair

Current Muse PR32 head `f73a3e7ae25c1f2fdcebc4af5578938b794fe218`
is preserved as an ancestor. Its file-token rotation, multi-address port
resolver, IPv6 URL helper, expanded qualification and CI review-artifact
workflow are retained. The repair adds fail-closed process-SID private
token storage, atomic first-run publication, existing-token hardening,
old-job cleanup during crash restart, exact nonrecursive payload removal,
CPython notice preservation and strict native ACL qualification.

Uninstall preserves unrelated files in a user-selected install location.
Default worker data removal remains an explicit separate choice. Installed
pairing and connected/inference-ready claims remain unimplemented. The tray
supervises local worker state only; default runtime remains simulated.

## Observed verification

- Clean pinned build, vendor/patch verification, hash-locked dependency
  installation and dependency consistency checks: PASS.
- 12 controlled packaging regressions: PASS, also gated by `build.py`.
- 5 independent review fixtures: original ffbe 5 failures; current Muse801
  3 failures and 2 passes; repaired candidate 5 passes.
- Frozen CLI help, simulated inspect, and tray help/status under temporary
  data with scrubbed environment: PASS. These smoke checks do not run a tray
  controller, start an installed worker, or change the user profile.
- Repaired headless coexistence qualification: 52 PASS, 0 FAIL, 4 explicit
  SKIP; process exit 0. Includes real frozen CLI/tray reuse, control,
  bounded crash recovery, private token ACLs, old-token401/new-token200 after
  restart, honest state and no remaining fixture listener. Every controller
  and mock request used temporary AIPSTER_WORKER_DATA; no installed profile
  or HKCU, shortcut or autostart entry was changed.
- Lead independent review of source at a2ec5e1: 12 source tests and 4 extra
  held-outs passed, including actual Windows concurrent token publication,
  failed existing-token hardening, escaped exact payload plans and mandatory
  verbatim interpreter notice. No additional source blocker was found.

This report is a documentation-only follow-up to the clean a2ec5e1 artifact
build. Its eventual documentation commit is not the source SHA embedded in
that artifact. Runtime and build/test source are unchanged by this report.

## External qualification remains HOLD

Full install/uninstall, HKCU/shortcuts/autostart, wizard consent paths,
actual tray/menu pixels and strict parent-death job confinement must be
qualified on fresh CI/owner Windows environments. No installer or uninstaller
was run against the current user profile. Headless mock behavior does not
replace these external checks. Signing is still absent; macOS/Linux remain
unavailable; no installer release or download link is published.

The original ffbe CI build succeeded, but qualification run40929040335 failed
two token ACL checks. Latest Muse801's attempt to classify failed ACL
hardening as a restricted-context PASS is replaced by strict SID-based
verification: inability to establish private token storage is terminal.
That old run is not evidence of passing repaired full-profile CI.

## Historical owner artifacts

The earlier owner artifact from d689d2e was 13,073,826 bytes with SHA-256
`b7e2b27668d3b659114dee11da442acccdac51fcd291aa9fb5682e7181b611fe`.
Muse801 documented an artifact from cd715b3 of 13,074,277 bytes, SHA-256
`7f463aae8ac1e620f8794335810a0959e039e5f7d2a1f0b955f0b4613eae0e5d`.
Its reported same-source rebuild comparison had 96 matching payload paths,
91 byte-identical files and timestamp-related variation in three executables,
base_library.zip and BUILD.json. That observation is historical owner
evidence; byte reproducibility of the repaired build is not claimed.
Earlier wizard screenshots and coexistence results likewise qualify their
recorded source/artifacts, not the repaired artifact above.


## Preserved Muse visual/CI history

Muse f73a3e7 adds uninstall data-choice/preserve-notice capture and waits for
Start Menu links before taking the screenshot; those driver changes are
preserved. Owner reports for runs40932568817 and40935178276 describe passing
full-profile install/registry/shortcut/autostart/control/uninstall checks,
but token ACL failures were accepted as restricted-context PASS. That
leniency is absent here, so these runs do not qualify strict private storage.

The owner reported reviewing CI artifact windows-installer-screenshots from
40935178276: welcome, license, default-off autostart component, editable temp
directory, finish with Start now unchecked, Start Menu spinner with links
log-verified, local worker console without token value, uninstall confirm,
unchecked Remove data, data-preserved notice and finish. It reported
installed=True/install removed=True/data preserved=True. This is attributed
historical evidence, not a new visual review of the native repaired build.
Actual tray/menu pixels, desktop opt-out and the checked removal box still
need owner review. No screenshot driver was run on the current desktop.
