# Hosting anlim.ai (2026-11-19) @anlim

Three pieces, none of them on your computer:

| Piece | Where | What runs |
|---|---|---|
| Database, sign-in, files, API | Supabase project `zejyuxnuzmvlcbpfklrg` (already live) | schema `studio`, Edge Functions `studio-api`, `studio-billing`, `studio-storage` |
| Worker + checker | Fly.io, one always-on machine (`Dockerfile`, `fly.toml`, `deploy/start.sh`) | `worker/src/worker.js` and `checker/service.py` side by side; the worker reaches the checker on 127.0.0.1:8787 |
| Web app | Vercel (`app/vercel.json`) | the Expo web export (`npx expo export -p web` -> `app/dist`) |

## 1. Worker on Fly.io (PowerShell)
Install flyctl (https://fly.io/docs/flyctl/install/), then:
```powershell
Set-Location "C:\vid_projects\_repo_stage\anlim-ai"
fly auth login
fly launch --no-deploy --copy-config --name anlim-worker
```
Secrets (Fly stores them encrypted; they never go in the repo). Copy each value from `C:\vid_projects\_app\worker\.env`:
```powershell
fly secrets set DATABASE_URL="..." SUPABASE_URL="..." STORAGE_TOKEN="..." FAL_KEY="..." CHECKER_TOKEN="..." ANTHROPIC_API_KEY="..." CHECKER_MAX_USD="..." --stage
fly deploy
fly logs
```
Only one worker should claim jobs at a time while you test: stop the local worker and checker before `fly deploy`
(two workers are safe, they use SKIP LOCKED leases, but it makes logs confusing).

Size: `shared-cpu-2x` with 2 GB. The checker loads OpenCV ONNX models and rembg (isnet-anime); 1 GB is likely too
small (not measured). Raise with `fly scale memory 4096` if logs show the process killed for memory.

## 2. Web app on Vercel
New project from the GitHub repo `ltdropsgenai/anlim-ai`, **Root Directory = `app`** (it reads `app/vercel.json`).
Environment variables (Production and Preview):
- `EXPO_PUBLIC_SUPABASE_URL` = `https://zejyuxnuzmvlcbpfklrg.supabase.co`
- `EXPO_PUBLIC_SUPABASE_KEY` = the project's publishable key (public by design)
- `EXPO_PUBLIC_TURNSTILE_SITE_KEY` = Cloudflare Turnstile site key (optional; turns the sign-up captcha on)

## 3. After the first web deploy
- Supabase Edge Function secret `APP_URLS`: add the Vercel URL (and your own domain later), comma separated.
  The API only answers browsers from origins in that list; Stripe return links are checked against it too.
- Supabase > Authentication > URL Configuration: Site URL and Redirect URLs = the same web address.
