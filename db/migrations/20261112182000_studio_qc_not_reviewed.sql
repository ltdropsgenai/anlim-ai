-- The checker can return NOT_REVIEWED (spec check or budget stopped the paid review); the worker sends it to review.
alter table studio.qc_runs drop constraint qc_runs_verdict_check;
alter table studio.qc_runs add constraint qc_runs_verdict_check check (verdict in ('PASS','FLAG','FAIL','NOT_REVIEWED','ERROR'));
