-- 2026-11-18 (applied): every shot names its cast. An empty cast_ids meant "everyone in the series", so adding a
-- character (e.g. a dog) silently added it to every existing shot. Existing empty casts filled with the series'
-- characters at the time (same meaning); create_shot fills the cast; set_shot_cast refuses an empty cast.
-- Applied through the Supabase migration "studio_shot_cast_explicit" (full function bodies there).
update studio.shots sh set cast_ids = sub.ids
from (select sc.id scene_id, coalesce(array_agg(c.id order by c.name), '{}') ids
        from studio.scenes sc left join studio.characters c on c.series_id = sc.series_id group by sc.id) sub
where sub.scene_id = sh.scene_id and cardinality(sh.cast_ids) = 0 and cardinality(sub.ids) > 0;
