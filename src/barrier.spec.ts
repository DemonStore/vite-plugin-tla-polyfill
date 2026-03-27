import { ChunkBarrier } from "./barrier";
import type { ChunkAnalysis } from "./types";

function makeAnalysis(hasTLA: boolean): ChunkAnalysis {
  return { hasTLA, hasDynamicImport: false, ast: null as any, code: "" };
}

describe("ChunkBarrier", () => {
  it("should resolve when all chunks are reported", async () => {
    const barrier = new ChunkBarrier();

    barrier.report("a.js", makeAnalysis(true), 2);
    barrier.report("b.js", makeAnalysis(false), 2);

    const results = await barrier.wait();
    expect(results.size).toBe(2);
    expect(results.get("a.js")!.hasTLA).toBe(true);
    expect(results.get("b.js")!.hasTLA).toBe(false);
  });

  it("should handle concurrent waiters", async () => {
    const barrier = new ChunkBarrier();

    const p1 = barrier.wait();
    const p2 = barrier.wait();

    barrier.report("a.js", makeAnalysis(true), 1);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.size).toBe(1);
    expect(r2.size).toBe(1);
  });

  it("should handle single chunk", async () => {
    const barrier = new ChunkBarrier();
    barrier.report("a.js", makeAnalysis(false), 1);

    const results = await barrier.wait();
    expect(results.size).toBe(1);
  });
});
