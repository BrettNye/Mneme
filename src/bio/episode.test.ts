import { createEpisodeRegistry } from "./episode.js";

it("open then close stamps endedAt and removes from the open set", () => {
  const r = createEpisodeRegistry();
  const ep = r.openEpisode("run-1");
  const closed = r.closeEpisode(ep.id);
  expect(closed?.endedAt).toBeGreaterThanOrEqual(closed!.startedAt);
  expect(r.get(ep.id)).toBeUndefined();
});

it("openEpisode returns a unique id and records startedAt; optional runId seeds runIds", () => {
  const r = createEpisodeRegistry();
  const ep1 = r.openEpisode("run-a");
  const ep2 = r.openEpisode();
  expect(ep1.id).not.toBe(ep2.id);
  expect(ep1.runIds).toEqual(["run-a"]);
  expect(ep2.runIds).toEqual([]);
  expect(typeof ep1.startedAt).toBe("number");
});

it("attachRun appends additional runIds to an open episode and returns true", () => {
  const r = createEpisodeRegistry();
  const ep = r.openEpisode("run-1");
  expect(r.attachRun(ep.id, "run-2")).toBe(true);
  expect(r.attachRun(ep.id, "run-3")).toBe(true);
  expect(r.get(ep.id)?.runIds).toEqual(["run-1", "run-2", "run-3"]);
});

it("attachRun returns false and changes nothing when the episode id is unknown", () => {
  const r = createEpisodeRegistry();
  const ep = r.openEpisode("run-1");
  expect(r.attachRun("nonexistent", "run-2")).toBe(false);
  expect(r.get(ep.id)?.runIds).toEqual(["run-1"]);
});

it("closeEpisode on an unknown id returns undefined", () => {
  const r = createEpisodeRegistry();
  expect(r.closeEpisode("nonexistent")).toBeUndefined();
});
