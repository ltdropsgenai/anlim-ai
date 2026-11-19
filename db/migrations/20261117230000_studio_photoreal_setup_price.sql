-- 2026-11-17 (applied): photoreal New setup = 30 credits, usd 0.12 (GPT Image 2.6 medium estimate; see the
-- comment in the applied migration "studio_photoreal_setup_price"). Patches studio.request_start_frame in place.
do $$
declare d text;
begin
  d := pg_get_functiondef('studio.request_start_frame(uuid,text,text,text)'::regprocedure);
  if position('v_cost := 30' in d) > 0 then return; end if;
  d := replace(d, $r$if v_look = 'photoreal' then v_endpoint := 'openai/gpt-image-2.6/sunburst/edit'; end if;$r$,
                  $r$if v_look = 'photoreal' then v_endpoint := 'openai/gpt-image-2.6/sunburst/edit'; v_cost := 30; end if;$r$);
  d := replace(d, $r$case when v_cost = 0 then 0 else 0.08 end$r$,
                  $r$case when v_cost = 0 then 0 when v_endpoint like 'openai/gpt-image%' then 0.12 else 0.08 end$r$);
  if position('v_cost := 30' in d) = 0 or position('then 0.12' in d) = 0 then raise exception 'pattern not found'; end if;
  execute d;
end $$;
