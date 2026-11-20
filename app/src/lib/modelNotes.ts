// What each video model is good at, in plain words (2026-11-20, Londi: "verbiage on the app about the strengths of
// each model"). Every claim comes from anlim's own held-out test (2026-11-19: 20 first-time-user prompts, 10 cartoon /
// 10 real-looking, one take per model, labelled blind by Londi; project doc anlim-heldout-model-test-2026-11-19) or
// from the price list (studio.models). Update these when a new test changes the picture. @anlim
export type ModelNote = { best: string; watch?: string };

export const MODEL_NOTES: Record<string, ModelNote> = {
  "kling-v4-i2v-720p": {
    best: "The best all-rounder in our tests: 16 of 19 clips usable as made, cartoon and real-looking alike. Clips up to 30 seconds.",
  },
  "seedance-2-0-i2v-720p": {
    best: "The strongest for cartoons: every cartoon clip in our tests was usable.",
    watch: "Cartoon only, since it refuses real-looking people. About twice the price of Kling 4.0.",
  },
  "minimax-h3-i2v-768p": {
    best: "The lowest price, less than half of Kling 4.0. Fine for simple shots.",
    watch: "About 2 in 3 clips were usable in our tests, so expect more retries.",
  },
  "kling-v3-pro-i2v": {
    best: "Cheaper than Kling 4.0, and most clips were usable in our tests.",
    watch: "Fewer came out right first time (6 of 20), so expect small fixes.",
  },
  "wan-2-7-i2v-720p": {
    best: "A low-cost option.",
    watch: "Only 8 of 20 clips were usable in our tests.",
  },
  "mock-i2v": { best: "For testing the app. Makes a placeholder clip." },
};

// Auto's line: what it does and which model it picks today
export const autoNote = (pickLabel: string | null): ModelNote => ({
  best: `Picks the model that tested best for your look and kind of shot${pickLabel ? ` (today: ${pickLabel})` : ""}.`,
});

// Motion transfer (2026-11-20). From anlim's own test the same day: one 12 s two-person clip with several camera cuts,
// run on each model and compared frame by frame with the source (project doc anlim-motion-transfer-test-2026-11-20).
// Uses are written for any creator, not only for fight scenes (Londi: "not everyone will use the motion transfer in
// the same manner").
export const MOTION_NOTES: Record<string, ModelNote> = {
  genjutsu: {
    best: "Keeps your clip shot for shot: every cut, camera move and person in frame, recast as your characters. In our test it matched the source beat for beat. Best for finished pieces.",
    watch: "Check close-ups: in one of our test runs two people swapped looks for a second. Up to 30 seconds.",
  },
  "genjutsu-light": {
    best: "Less than half the price. Good for drafts, one-person clips and trying a look before you pay for the full version.",
    watch: "In our test it turned close-ups into wider shots, and the first two seconds kept the source's clothing colours. Uses the first 15 seconds.",
  },
  "mock-motion": { best: "For testing the app. Hands back a placeholder clip." },
};
// Which note a motion model id gets: genjutsu-mt-720p -> genjutsu, genjutsu-light-mt-480p -> genjutsu-light
export const motionFamily = (id: string) => id.startsWith("genjutsu-light") ? "genjutsu-light" : id.startsWith("genjutsu") ? "genjutsu" : id;

// What people use motion transfer for: shown on the Motion transfer screen.
export const MOTION_USES: { title: string; text: string }[] = [
  { title: "Perform as anyone", text: "Film yourself dancing, acting or presenting, then become your cartoon character, mascot, avatar or another (consenting) person." },
  { title: "Restyle your footage", text: "Turn a phone video, a skit or a music-video take into anime, a 3D cartoon, a painted look, or a different real-looking cast." },
  { title: "Move the scene", text: "Keep the action and the camera, change where it happens: a stage, a rooftop, a classroom, another world." },
  { title: "Keep a cast consistent", text: "Reuse the same character images across clips so your people look the same in every episode." },
];
