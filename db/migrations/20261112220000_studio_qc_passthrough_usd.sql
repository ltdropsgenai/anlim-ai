-- Cost of the furniture walk-through check (passthrough_check.py), per checker run.
alter table studio.qc_runs add column if not exists passthrough_usd numeric(10,4) not null default 0;
