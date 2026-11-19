-- Local e2e seed: one creator with 1,000 credits, a two-character series, one approved shot per scenario.
insert into auth.users(id, email) values ('00000000-0000-4000-8000-0000000c0de1', 'test@example.invalid');
select studio.grant_credits('00000000-0000-4000-8000-0000000c0de1', 1000, 'grant', 'e2e');
insert into studio.series(id, owner, name, style_prompt) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000c0de1', 'Layana & King', '2D children''s cartoon, 16:9');
insert into studio.characters(series_id, name, height_units, wardrobe) values
  ('10000000-0000-4000-8000-000000000001', 'Layana', 10, 'black ruffled top, white leggings'),
  ('10000000-0000-4000-8000-000000000001', 'King', 8, 'black cap, black track suit with red stripes');
insert into studio.scenes(id, series_id, title) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Playroom');
insert into studio.shots(id, scene_id, ord, action, duration_s, start_frame_path, start_frame_approved, status)
select ('30000000-0000-4000-8000-00000000000' || n)::uuid, '20000000-0000-4000-8000-000000000001', n,
       'Layana hands King the toy truck.', 5, '00000000-0000-4000-8000-0000000c0de1/stills/s1.png', true, 'ready'
from generate_series(1, 4) n;
