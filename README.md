# Cartoon Studio app: core loop (v0.1, 2026-11-12) @anlim

The loop that turns an approved start frame into a checked, paid-for clip:

```
creator approves start still --> studio.enqueue_generation()  (credits reserved, row "queued")
worker   queued   --> compile prompt + signed start-frame URL --> fal Kling 4.0 (720p, start frame only) --> "running"
worker   running  --> poll fal --> download, strip audio, store in bucket "studio" --> "checking"
worker   checking --> checker service (frame_check/pipeline.py) --> qc_runs row
                      PASS  -> charge, "succeeded", shot "review" (creator still picks the take)
                      FLAG / NOT_REVIEWED -> "review" (credits stay reserved until the creator decides)
                      FAIL  -> release (credits back); no automatic retry, the creator decides (2026-11-16)
creator  studio.review_generation(approve | reject)  -> approve charges; rejecting a FLAGGED clip releases
provider error / timeout -> release, "failed"
```

| Folder | What |
|---|---|
| `db\migrations\` | SQL applied to Supabase project **RideLink** (`zejyuxnuzmvlcbpfklrg`), schema **`studio`** only |
| `worker\` | Node 20+ service (`pg` only). Claims jobs with `FOR UPDATE SKIP LOCKED` leases, so several workers can run |
| `checker\service.py` | Python stdlib HTTP service on 127.0.0.1:8787; calls `C:\vid_projects\_tools\frame_check\pipeline.py` |
| `app\` | Expo Router app, web first: sign in, review queue, clip player with flagged-moment marks, approve/reject |
| `supabase\functions\` | Edge Functions: `studio-api` (the app's backend, runs every query as the signed-in creator) and `studio-storage` (worker file links) |
| `db\e2e_local.sh` | End-to-end test on a throwaway Postgres: mock provider, fake checker, local storage (passed 2026-11-12) |

## Data (schema `studio` in RideLink)
`models` (price list) · `accounts` (balance, reserved) · `credit_ledger` (append-only: purchase, grant, reserve,
charge, release, refund) · `series` · `characters` (height_units, wardrobe, refs) · `locations` · `scenes`
(blocking) · `shots` (action, start/end frame, cast_ids, status) · `generations` (queue + state) · `qc_runs`
(verdict, frame_flags with timestamps for the review UI, checker $) · `reviews` (creator decisions = checker
agreement metric). RLS: creators read their own rows and edit their own series/characters/scenes/shots; money
and queue changes only through the `studio.*` functions.

Credits: 1 credit = $0.01 of price. Kling 4.0 720p on fal is $0.157/s; at a 60% margin that is $0.3925/s, so
**40 credits per second, 200 per 5 s clip** (`studio.models`). Checker cost is inside that price, not charged
separately.

## Setup (once)
`worker\.env` holds the settings (template: `worker\.env.example`; never commit `.env`). Filled in on
2026-11-12 except **FAL_KEY**, which only you can create (fal.ai > Dashboard > Keys; fal bills $0.157/s at 720p):
- `DATABASE_URL`: the worker's own login **studio_worker**, which can only touch the `studio` schema (RideLink's
  tables are refused). Host `aws-1-us-east-2.pooler.supabase.com` (aws-0 does not serve this project).
- `STORAGE_TOKEN`: the worker gets one-time upload/download links from the Edge Function **studio-storage**, which
  holds this token's SHA-256; the service_role key never leaves Supabase. Rotate = new token + redeploy the hash.
- `CHECKER_TOKEN`: shared by worker and checker; the checker reads it from `worker\.env` itself.

## Run (PowerShell, two windows)
```powershell
$APP = "C:\vid_projects\_app"
Set-Location "$APP\checker"
python "$APP\checker\service.py"
```
```powershell
$APP = "C:\vid_projects\_app"
Set-Location "$APP\worker"
npm install
node --env-file="$APP\worker\.env" "$APP\worker\src\worker.js"
```

## Review app (PowerShell, third window)
```powershell
$APP = "C:\vid_projects\_app"
Set-Location "$APP\app"
npm install
npx expo start --web
```
Opens http://localhost:8081. Dev login in `C:\vid_projects\_app\dev_login.txt` (git-ignored). The app holds only public
values (`app\.env`: Supabase URL + publishable key); studio data goes through `studio-api`, which checks the sign-in and
runs as that user, so row-level security decides what is visible. One decision per clip.

## Known limits (v0.1)
- Shares RideLink's `auth.users`: fine for development, separate before real customers.
- The checker runs on the same machine as the worker (local file paths). A hosted worker needs the checker next
  to it, or clip upload to the checker.
- Very fast action drawn on twos with cuts is untested in the checker (Name That Fight EP20).
- Policy v1: rejecting a FLAGGED clip refunds it; rejecting a checker PASS does not. Revisit with real usage.
- Prompt template wording is a first guess; tune with the Phase 0 clips.
- Not built yet: native video player (the review screen is web only), shot planner/compiler questions, start-still generation, Stripe/RevenueCat, webhooks
  (the worker polls fal every 15 s instead).
