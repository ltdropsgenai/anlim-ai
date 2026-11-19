// Mock provider for tests: "renders" by returning a local clip after one poll. No spend.
// MOCK_CLIP = path of an mp4 to hand back; MOCK_FAIL=1 makes every job fail at the provider.
export async function submit(endpoint, input) {
  return { requestId: `mock-${Date.now()}`, statusUrl: "mock://status", responseUrl: "mock://result" };
}

// MOCK_IMAGE = path of a png to hand back as the edited end frame.
export async function pollImage(job) {
  if (process.env.MOCK_FAIL === "1") return { state: "failed", error: "mock provider failure" };
  if (process.env.MOCK_FILTER === "1") return { state: "failed", error: 'fal 422: {"type":"content_policy_violation"}' };
  if (Date.now() - new Date(job.submitted_at).getTime() < 1000) return { state: "pending" };
  const img = process.env.MOCK_IMAGE;
  if (!img) return { state: "failed", error: "set MOCK_IMAGE" };
  return { state: "done", imageUrl: `file://${img}` };
}

export async function poll(gen) {
  if (process.env.MOCK_FAIL === "1") return { state: "failed", error: "mock provider failure" };
  if (Date.now() - new Date(gen.submitted_at).getTime() < 1000) return { state: "pending" };   // still "rendering"
  const clip = process.env.MOCK_CLIP;
  if (!clip) return { state: "failed", error: "set MOCK_CLIP" };
  return { state: "done", videoUrl: `file://${clip}` };
}
