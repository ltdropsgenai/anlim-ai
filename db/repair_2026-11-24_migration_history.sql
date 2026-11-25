-- Review 2026-11-24, finding 3: these six migrations are live (their columns, functions and table exist) but were run
-- outside the migration tool, so supabase_migrations.schema_migrations has no rows for them. This records them, as
-- `supabase migration repair --status applied <version>` would. No schema change. @anlim
insert into supabase_migrations.schema_migrations(version, name) values
  ('20261123090000', 'studio_review_fixes'),
  ('20261123110000', 'studio_shot_words'),
  ('20261123140000', 'studio_billing_modes'),
  ('20261123150000', 'studio_scene_narration'),
  ('20261123160000', 'studio_billing_mode_guard'),
  ('20261123170000', 'studio_review_fixes_2')
on conflict (version) do nothing;
