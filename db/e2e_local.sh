#!/usr/bin/env bash
# Local end-to-end test of the core loop (mock provider, checker in fake mode, local storage). No spend.
set -euo pipefail
S=${PGSOCK:?}; T=${E2E_DIR:?}; APP=$(cd "$(dirname "$0")/.." && pwd)
P="psql -h $S -p 55432 -U postgres -d studio_test -qAt -v ON_ERROR_STOP=1"
export DATABASE_URL="postgresql://postgres@localhost:55432/studio_test?host=$S" STORAGE_MODE=local LOCAL_STORAGE_DIR=$T/storage \
       WORK_DIR=$T/work CHECKER_TOKEN=e2e-token CHECKER_URL=http://127.0.0.1:8799 PROVIDER_POLL_MS=200 WORKER_IDLE_MS=200 \
       MOCK_CLIP=$T/mock_clip.mp4
CHECKER_MODE=fake CHECKER_PORT=8799 python3 "$APP/checker/service.py" > $T/checker.log 2>&1 & CK=$!
trap 'kill $CK 2>/dev/null' EXIT; sleep 1
$P -c "update studio.models set credits_per_second = 40 where id = 'mock-i2v'"     # real-sized reservations (200/clip)
U=00000000-0000-4000-8000-0000000c0de1
bal() { $P -c "select balance||'/'||reserved from studio.accounts where owner='$U'"; }
work() {   # run the worker until nothing is in flight (max 30 passes)
  for i in $(seq 30); do
    [ "$($P -c "select (select count(*) from studio.generations where status in ('queued','running','checking'))
                       + (select count(*) from studio.frame_jobs where status in ('queued','running','composing'))")" = 0 ] && return
    (cd "$APP/worker" && node src/worker.js --once >> $T/worker.log 2>&1); sleep 0.3
  done; echo "work: still in flight after 30 passes"; }
g() { $P -c "select status||' settled='||coalesce(settled,'-')||' charged='||credits_charged from studio.generations where shot_id='$1' order by created_at"; }
enq() { $P -c "select studio.enqueue_generation('$1', 'mock-i2v')" >/dev/null; }
S1=30000000-0000-4000-8000-000000000001; S2=${S1%1}2; S3=${S1%1}3; S4=${S1%1}4

echo "start balance/reserved: $(bal)"
enq $S1; echo "after enqueue (expect 1000/200): $(bal)"
FAKE_VERDICT=PASS work; echo "S1 PASS -> $(g $S1) | shot $($P -c "select status from studio.shots where id='$S1'") | bal $(bal)"

enq $S2; FAKE_VERDICT=FAIL work
echo "S2 FAIL (released, no automatic retry: expect one generation, failed settled=released) -> $(g $S2 | tr '\n' ';') bal $(bal)"
enq $S3; FAKE_VERDICT=FLAG work; echo "S3 FLAG -> $(g $S3) bal $(bal)"
G3=$($P -c "select id from studio.generations where shot_id='$S3'")
$P -c "select set_config('request.jwt.claim.sub', '$U', false); select studio.review_generation('$G3', 'approve')" >/dev/null
echo "S3 approved -> $(g $S3) | shot $($P -c "select status from studio.shots where id='$S3'") | bal $(bal)"

enq $S4; MOCK_FAIL=1 FAKE_VERDICT=PASS work; echo "S4 provider fail -> $(g $S4) | bal $(bal)"

# End-frame gate (checked before submit): a drifted end frame fails for free; a clean one goes through.
$P -c "update studio.shots set end_frame_path = start_frame_path, end_frame_approved = true where id in ('$S1', '$S2')"
enq $S1; FAKE_END_FRAME=FLAG FAKE_VERDICT=PASS work
echo "S1 end frame FLAG -> $(g $S1 | tail -1) | submitted=$($P -c "select count(*) from studio.generations where shot_id='$S1' and provider_request_id is not null") | bal $(bal)"
echo "   error: $($P -c "select left(error, 70) from studio.generations where shot_id='$S1' order by created_at desc limit 1")"
enq $S2; FAKE_END_FRAME=PASS FAKE_VERDICT=PASS work; echo "S2 end frame PASS -> $(g $S2 | tail -1) | bal $(bal)"

# End frames made in the app (frames.js): request -> mock image edit -> compose (fake) -> ready, charged 20 -> approve.
fj() { $P -c "select status||' settled='||coalesce(settled,'-')||' check='||coalesce(check_result->>'verdict','-')||' composed='||(composed_path is not null) from studio.frame_jobs where shot_id='$1' order by created_at desc limit 1"; }
$P -c "update studio.shots set end_frame_path = null, end_frame_approved = false where id = '$S3'"
B0=$(bal); $P -c "select studio.request_end_frame('$S3', 'King sits down on the sofa')" >/dev/null
echo "end frame requested: bal $B0 -> $(bal) (expect 20 reserved)"
IMAGE_PROVIDER=mock MOCK_IMAGE=$T/storage/$U/stills/s1.png FAKE_END_FRAME=PASS work
echo "end frame made -> $(fj $S3) | bal $(bal) | prompt starts: $($P -c "select left(prompt, 60) from studio.frame_jobs where shot_id='$S3'")"
echo "   stored: $(ls $T/storage/$U/frames/*/ 2>/dev/null | sort | tr '\n' ' ')"
J=$($P -c "select id from studio.frame_jobs where shot_id='$S3' order by created_at desc limit 1")
$P -c "select set_config('request.jwt.claim.sub', '$U', false); select studio.decide_end_frame('$J', 'approve')" >/dev/null
echo "approved -> shot end frame: $($P -c "select (end_frame_path like '%/frames/%/end.png')||' approved='||end_frame_approved from studio.shots where id='$S3'")"
$P -c "select studio.request_end_frame('$S4', 'Layana waves')" >/dev/null
IMAGE_PROVIDER=mock MOCK_FAIL=1 work; echo "edit fails -> $(fj $S4) | bal $(bal) (expect nothing charged)"

# ---- Start stills, plates, locations, references (start_stills migration) ----
asu() { $P -c "select set_config('request.jwt.claim.sub', '$U', false)" -c "$1" | tail -1; }        # as the creator
try() { asu "$1" 2>&1 | grep -o 'ERROR:.*' | head -1 || true; }                                     # expect a refusal
sj() { $P -c "select kind||'/'||coalesce(mode,'-')||' '||status||' settled='||coalesce(settled,'-')||' reserved='||credits_reserved||' check='||coalesce(check_result->>'verdict','-') from studio.frame_jobs where id='$1'"; }
echo "--- start stills"
echo "continue, first shot: $(try "select studio.request_start_frame('$S1', 'continue')")"
echo "continue, previous clip not approved: $(try "select studio.request_start_frame('$S2', 'continue')")"
B0=$(bal); J=$(asu "select studio.request_start_frame('$S4', 'continue')")
echo "continue S4 (S3 clip approved) requested: bal $B0 -> $(bal) (expect no change)"
FAKE_END_FRAME=PASS work
echo "continue -> $(sj $J) | out $($P -c "select composed_path from studio.frame_jobs where id='$J'" | sed "s|$U|<owner>|")"
F=$T/storage/$($P -c "select composed_path from studio.frame_jobs where id='$J'")
echo "   last frame png: $(python3 -c "import sys;b=open('$F','rb').read(24);print(b[1:4]==b'PNG', int.from_bytes(b[16:20],'big'),'x',int.from_bytes(b[20:24],'big'))") (mock clip $(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0:s=x $T/mock_clip.mp4))"
asu "select studio.decide_frame('$J', 'approve')" >/dev/null
echo "approved -> S4 start: $($P -c "select (start_frame_path = (select composed_path from studio.frame_jobs where id='$J'))||' approved='||start_frame_approved||' end='||coalesce(end_frame_path,'none') from studio.shots where id='$S4'")"

B0=$(bal); J=$(asu "select studio.request_start_frame('$S4', 'reposition', 'Layana sits on the sofa; King stands by the shelf.')")
echo "reposition S4 (default source = previous clip's last frame): bal $B0 -> $(bal) | while in flight: $(try "select studio.request_start_frame('$S4', 'continue')")"
IMAGE_PROVIDER=mock MOCK_IMAGE=$T/storage/$U/stills/s1.png FAKE_END_FRAME=PASS work
echo "reposition -> $(sj $J) | bal $(bal) | source $($P -c "select source_path from studio.frame_jobs where id='$J'" | sed "s|$U|<owner>|")"
echo "   $(grep "\[frame ${J:0:8}\]" $T/worker.log | grep -o 'start/reposition submitted.*image(s)')"
echo "--- plates and locations"
L=$(asu "select studio.create_location('10000000-0000-4000-8000-000000000001', 'Playroom', 'blue sofa, toy shelf')")
echo "new_setup with no location: $(try "select studio.request_start_frame('$S2', 'new_setup', 'Both stand by the window.')")"
asu "select studio.set_scene_location('20000000-0000-4000-8000-000000000001', '$L')" >/dev/null
echo "new_setup with no plate: $(try "select studio.request_start_frame('$S2', 'new_setup', 'Both stand by the window.')")"
B0=$(bal); J=$(asu "select studio.request_plate('$L', '$S1')")
IMAGE_PROVIDER=mock MOCK_IMAGE=$T/storage/$U/stills/s1.png FAKE_END_FRAME=PASS work
echo "plate -> $(sj $J) | bal $B0 -> $(bal) | $(grep "\[frame ${J:0:8}\]" $T/worker.log | grep -o 'plate submitted.*image(s)')"
asu "select studio.decide_frame('$J', 'approve')" >/dev/null
echo "approved -> location plate: $($P -c "select layout_path from studio.locations where id='$L'" | sed "s|$U|<owner>|")"
J=$(asu "select studio.request_plate('$L', '$S1')"); B0=$(bal)
IMAGE_PROVIDER=mock MOCK_FILTER=1 work
echo "plate refused by the content filter twice -> $(sj $J) | bal $B0 -> $(bal) | resubmits: $(grep -c "\[frame ${J:0:8}\] content filter refused" $T/worker.log)"
echo "   error: $($P -c "select error from studio.frame_jobs where id='$J'" | cut -c1-90)"
echo "--- character references"
echo "new_setup with no references: $(try "select studio.request_start_frame('$S2', 'new_setup', 'Both stand by the window.')")"
mkdir -p $T/storage/$U/characters
for c in layana king; do cp $T/storage/$U/stills/s1.png $T/storage/$U/characters/$c.png
  $P -c "insert into storage.objects(bucket_id, name) select 'studio', '$U/characters/$c.png' where not exists (select 1 from storage.objects where name = '$U/characters/$c.png')"; done
echo "someone else's file: $(try "select studio.set_character_ref((select id from studio.characters where name='King'), '00000000-0000-4000-8000-00000000beef/characters/king.png')")"
echo "not uploaded: $(try "select studio.set_character_ref((select id from studio.characters where name='King'), '$U/characters/nope.png')" | sed "s|$U|<owner>|")"
asu "select studio.set_character_ref(id, '$U/characters/'||lower(name)||'.png') from studio.characters" >/dev/null
B0=$(bal); J=$(asu "select studio.request_start_frame('$S2', 'new_setup', 'Layana stands by the window; King sits on the sofa.')")
IMAGE_PROVIDER=mock MOCK_IMAGE=$T/storage/$U/stills/s1.png FAKE_END_FRAME=PASS work
echo "new_setup S2 -> $(sj $J) | bal $B0 -> $(bal) | $(grep "\[frame ${J:0:8}\]" $T/worker.log | grep -o 'start/new_setup submitted.*image(s)')"
echo "   refs: $($P -c "select array_to_string(ref_names, ',')||' heights '||array_to_string(ref_heights, ',')||' base=plate:'||(source_path = (select layout_path from studio.locations where id='$L')) from studio.frame_jobs where id='$J'")"
echo "   prompt: $($P -c "select prompt from studio.frame_jobs where id='$J'" | cut -c1-230)..."
asu "select studio.decide_frame('$J', 'discard')" >/dev/null; echo "discarded -> $(sj $J) | S2 start unchanged: $($P -c "select start_frame_path like '%/s1.png' from studio.shots where id='$S2'")"
echo "--- cast"
echo "cast from another series: $(try "select studio.set_shot_cast('$S3', array['00000000-0000-4000-8000-00000000beef'::uuid])")"
asu "select studio.set_shot_cast('$S3', array[(select id from studio.characters where name='King')])" >/dev/null
J=$(asu "select studio.request_start_frame('$S3', 'new_setup', 'King sits on the sofa.')")
echo "new_setup S3, cast King only -> refs $($P -c "select array_to_string(ref_names, ',') from studio.frame_jobs where id='$J'")"
IMAGE_PROVIDER=mock MOCK_IMAGE=$T/storage/$U/stills/s1.png FAKE_END_FRAME=PASS work
echo "   prompt: $($P -c "select prompt from studio.frame_jobs where id='$J'" | cut -c1-120)..."
echo "--- other creator"
$P -c "insert into auth.users(id, email) values ('00000000-0000-4000-8000-00000000beef', 'other@example.invalid') on conflict do nothing"
other() { $P -c "select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000beef', false)" -c "$1" 2>&1 | grep -o 'ERROR:.*' | head -1; }
echo "start frame: $(other "select studio.request_start_frame('$S4', 'continue')") | plate: $(other "select studio.request_plate('$L', '$S1')") | decide: $(other "select studio.decide_frame('$J', 'approve')")"
echo "delete S4 (paid frame): $(try "select studio.delete_shot('$S4')")"

n=0; for f in $T/storage/$U/generations/*.mp4; do n=$((n + $(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$f" | wc -l))); done
echo "audio streams left in $(ls $T/storage/$U/generations | wc -l) stored clips: $n (source clip has $(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 $T/mock_clip.mp4 | wc -l))"
echo "ledger: $($P -c "select string_agg(kind||':'||credits, ' ' order by id) from studio.credit_ledger")"
echo "qc_runs: $($P -c "select string_agg(verdict, ' ' order by created_at) from studio.qc_runs")"
