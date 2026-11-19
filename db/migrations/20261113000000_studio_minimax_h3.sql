-- MiniMax H3 image-to-video on fal, 768P. @anlim
-- Endpoint and fields: https://fal.ai/models/minimax/h3/image-to-video/api (read 2026-11-12).
-- Cost $0.06/s at 768P (fal pricing, read 2026-11-12). Credits use the same margin as Kling 4.0 (40 credits/s =
-- $0.40 of price for $0.157 of cost, ~61% margin): 0.06 / (1 - 0.6) = $0.15/s -> 15 credits/s, 75 for a 5 s clip.
insert into studio.models(id, provider, endpoint, resolution, credits_per_second, usd_per_second) values
  ('minimax-h3-i2v-768p', 'fal', 'minimax/h3/image-to-video', '768P', 15, 0.06)
on conflict (id) do nothing;
