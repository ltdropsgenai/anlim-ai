// Video guides shown on Help & contact (2026-11-23, Londi: "Videos live in-app help and eventually on YouTube, TikTok
// and Instagram"). Each file is served from app/public/tutorials/ (16:9 MP4 with its .vtt captions and a poster frame).
// Add an episode here only once its files are in public/tutorials/, so the page never shows a broken player. @anlim
export type Tutorial = { ep: number; title: string; what: string; seconds: number; file: string; poster: string; captions?: string };

export const TUTORIALS: Tutorial[] = [];
