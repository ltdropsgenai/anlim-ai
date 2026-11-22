-- 2026-11-22 (promo shot 3): make_end_image with the cast failed every time. request_end_setup (20261122130000) inserts an
-- end job with mode 'new_setup', but frame_jobs_mode (20261113220000) allowed a mode only on start jobs, so the insert was
-- refused ("violates check constraint frame_jobs_mode"); no end job with a mode was ever stored. The worker already handles
-- kind 'end' with mode 'new_setup'. Start jobs still need a mode; end jobs may have none (an edit) or 'new_setup' (with the
-- cast); every other kind has none. @anlim

alter table studio.frame_jobs drop constraint if exists frame_jobs_mode;
alter table studio.frame_jobs add constraint frame_jobs_mode check (
  case kind
    when 'start' then mode is not null
    when 'end' then mode is null or mode = 'new_setup'
    else mode is null
  end);
