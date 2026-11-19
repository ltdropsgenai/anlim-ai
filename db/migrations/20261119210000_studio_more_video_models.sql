-- More video models (2026-11-19, Londi: "I don't know that Kling is the right model"; held-out test of 20 first-time-user
-- prompts on five models). Credits per second keep the Kling 4.0 ratio (40 credits for $0.157 = ~255 credits per $),
-- rounded up. Prices from each model's fal llms.txt page, read 2026-11-19:
--   Kling 3.0 Pro i2v $0.112/s (audio off), Wan 2.7 i2v $0.10/s at 720p, Seedance 2.0 i2v $0.3034/s at 720p.
-- They are not in model_routes, so Auto never picks them until a route test backs them; the Render panel lists them as
-- manual picks with the "not Auto's pick" note. Worker input adapters: worker/src/compile.js ADAPTERS. @anlim
insert into studio.models (id, provider, endpoint, resolution, credits_per_second, usd_per_second, active, min_duration_s, max_duration_s, label) values
  ('kling-v3-pro-i2v',      'fal', 'fal-ai/kling-video/v3/pro/image-to-video', '720p', 29, 0.112,  true, 3, 15, 'Kling 3.0 Pro'),
  ('wan-2-7-i2v-720p',      'fal', 'fal-ai/wan/v2.7/image-to-video',           '720p', 26, 0.10,   true, 2, 15, 'Wan 2.7'),
  ('seedance-2-0-i2v-720p', 'fal', 'bytedance/seedance-2.0/image-to-video',    '720p', 78, 0.3034, true, 4, 15, 'Seedance 2.0')
on conflict (id) do nothing;
