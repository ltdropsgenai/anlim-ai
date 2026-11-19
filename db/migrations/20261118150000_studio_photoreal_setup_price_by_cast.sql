-- 2026-11-18 (applied): photoreal New setup (GPT Image 2.6 medium) priced by cast size (Londi).
-- Measured $0.092 a frame with 2 people (fal usage: $1.38 for 15 medium requests). Each extra person adds one
-- reference image as input, ~1,300 image tokens x $8/1M = ~$0.012 (estimate). Cost = 0.068 + 0.012 x people;
-- credits at 250 per dollar = 17 + 3 x people (1 -> 20, 2 -> 23, 3 -> 26, 4 -> 29, 5 -> 32, 6 -> 35).
-- Patches studio.request_start_frame as left by 20261117230000 (30 credits / 0.12, then 0.09 the same morning).
do $$
declare d text;
begin
  d := pg_get_functiondef('studio.request_start_frame(uuid,text,text,text)'::regprocedure);
  if position('17 + 3 * v_n' in d) > 0 then return; end if;
  d := replace(d, $r$v_endpoint := 'openai/gpt-image-2.6/sunburst/edit'; v_cost := 30; end if;$r$,
                  $r$v_endpoint := 'openai/gpt-image-2.6/sunburst/edit'; v_cost := 17 + 3 * v_n; end if;$r$);
  d := replace(d, $r$when v_endpoint like 'openai/gpt-image%' then 0.12 else$r$,
                  $r$when v_endpoint like 'openai/gpt-image%' then 0.068 + 0.012 * coalesce(v_n, 2) else$r$);
  d := replace(d, $r$when v_endpoint like 'openai/gpt-image%' then 0.09 else$r$,
                  $r$when v_endpoint like 'openai/gpt-image%' then 0.068 + 0.012 * coalesce(v_n, 2) else$r$);
  if position('17 + 3 * v_n' in d) = 0 or position('0.068 + 0.012' in d) = 0 then raise exception 'pattern not found'; end if;
  execute d;
end $$;
