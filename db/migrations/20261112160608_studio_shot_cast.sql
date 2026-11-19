-- Which characters are in the shot (empty = every character of the series). The checker counts people from it.
alter table studio.shots add column cast_ids uuid[] not null default '{}';
