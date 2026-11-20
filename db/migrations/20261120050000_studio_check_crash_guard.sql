-- Crash guard for clip checks (2026-11-20). A check that runs the Fly machine out of memory kills the worker with it,
-- so the step's normal retry counter (tries) never moves and the same check started again after every restart (the
-- 2026-11-20 loop: oom_killed about every 9 minutes). The worker now stamps check_started_at before it asks the
-- checker and clears it when the checker answers; a stamp still there when the clip is claimed again means the last
-- check died with the machine. After 2 such deaths the clip goes to review unchecked (charged, as for a checker that
-- gave up) and the queue moves on. @anlim
alter table studio.generations add column if not exists check_started_at timestamptz;
alter table studio.generations add column if not exists check_crashes integer not null default 0;
