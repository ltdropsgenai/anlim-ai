-- Assets: show a clip's model by its display name (Kling 4.0), not its id (2026-11-19). @anlim
do $$ declare d text; begin
  d := pg_get_functiondef('studio.my_assets()'::regprocedure);
  d := replace(d, 'coalesce(m.label, g.model_id), g.output_path, g.preview_path, sh.start_frame_path, g.model_id,',
                  'coalesce(m.label, g.model_id), g.output_path, g.preview_path, sh.start_frame_path, coalesce(m.label, g.model_id),');
  execute d;
end $$;
