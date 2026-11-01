# AIPSTER 60–90 second demo shot list

No recorded video exists yet (verified 2026-10-31: no video links on the
deployed site or in this repository). Record the journey below with an
authorized test identity, upload it, and link the upload from the README demo
section. Exact missing items, both owner actions: (1) a test identity the
recorder is authorized to use — either a GitHub test account approved for the
public-signup sign-in, or the seeded demo credential delivered via a private
channel (never typed visibly, recorded, or committed); (2) a publishing
destination plus explicit upload authorization. No destination, approval,
account, or credential change is implied by this list.

## Setup (before recording)

- Use the deployed build: [https://aipster.net/](https://aipster.net/)
  (per the release owner's check, production served `06d90bd` at 2026-10-31 21:39 UTC; confirm the current
  commit in [deployment.json](https://aipster.net/deployment.json) before recording.
  The README screenshots are a historical capture of `d1de902`).
- Record at 1440×900 or 1920×1080, browser chrome visible so the URL is
  readable. 60–90 seconds total.
- Use an authorized test identity (GitHub test account or the seeded demo
  login). Never type a real password on screen; cut from the username field
  to the signed-in panel, or blank the password keystrokes in edit.
- Do not show operator credentials, tokens, URLs with secrets, or private
  inventory. The demo workspace contains simulated data only.

## Shots

| # | Time | Shot | Narration |
|---|------|------|-----------|
| 1 | 0:00–0:10 | Landing page hero: wordmark, “Now you’re the ISP”, sponsor strip. | “AIPSTER: your AI compute, shared on your terms.” |
| 2 | 0:10–0:20 | Scroll through the direction section; pause on “not live yet”. | “The direction: permissioned sharing with limits and revocation. Sharing itself is not live yet.” |
| 3 | 0:20–0:30 | Click Sign in → `/app` sign-in screen (GitHub + demo options). | “Sign in with GitHub, or explore the seeded demo workspace.” |
| 4 | 0:30–0:50 | Complete sign-in (cut over credential entry); tour the signed-in panel: compute, sharing, API keys. Name each screen as simulated where labeled. | “Inside: compute inventory, permissioned sharing, and scoped API keys.” |
| 5 | 0:50–1:05 | Show one honest boundary: sign out, then show the API returning `401` unauthenticated (or the sign-in screen again). | “Signed out, the API refuses without a session.” |
| 6 | 1:05–1:20 | Closing card or voiceover: URL, deployed commit, date. | “Live at aipster.net. Catalog, live inference, and billing are explicitly not in this build.” |

Total: ~80 seconds. If sign-in is unavailable at record time, stop after shot 3
and say so on camera; do not substitute local or mock footage without labeling it.

## After upload

- Link the video from the README demo section (step 3), with the recorded date
  and the deployed commit it shows.
- If the deployment has moved on, re-verify each shot against the new build and
  update this list; never present stale footage as current.
