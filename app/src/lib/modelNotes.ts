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
