import type { ChunkAnalysis } from "./types";

export class ChunkBarrier {
  private results = new Map<string, ChunkAnalysis>();
  private expectedTotal = 0;
  private resolve!: () => void;
  private ready: Promise<void>;

  constructor() {
    this.ready = new Promise(r => (this.resolve = r));
  }

  report(fileName: string, analysis: ChunkAnalysis, totalChunks: number): void {
    this.results.set(fileName, analysis);
    this.expectedTotal = totalChunks;
    if (this.results.size >= this.expectedTotal) {
      this.resolve();
    }
  }

  async wait(): Promise<Map<string, ChunkAnalysis>> {
    await this.ready;
    return this.results;
  }
}
