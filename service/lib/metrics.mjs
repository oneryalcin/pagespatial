/** Per-stage timing aggregation: pages/sec, p50/p95 per stage, peak rss. */
export class Metrics {
  constructor() {
    this.stages = new Map();
    this.walls = [];
    this.rssPeak = 0;
    this.firstMs = undefined;
    this.lastMs = undefined;
  }

  record(jobId, stageTimingsMs, wallMs, rssBytes) {
    const now = Date.now();
    if (this.firstMs === undefined) this.firstMs = now;
    this.lastMs = now;
    this.walls.push(wallMs);
    if (rssBytes > this.rssPeak) this.rssPeak = rssBytes;
    for (const [stage, ms] of Object.entries(stageTimingsMs ?? {})) {
      if (!this.stages.has(stage)) this.stages.set(stage, []);
      this.stages.get(stage).push(ms);
    }
  }

  snapshot() {
    const stageStats = {};
    for (const [stage, samples] of this.stages) stageStats[stage] = stats(samples);
    const elapsedSec = this.firstMs === undefined ? 0 : Math.max(0.001, (this.lastMs - this.firstMs) / 1000);
    return {
      pagesMeasured: this.walls.length,
      pagesPerSecond: this.walls.length < 2 ? null : Math.round((this.walls.length / elapsedSec) * 100) / 100,
      pageWallMs: stats(this.walls),
      stageMs: stageStats,
      workerRssPeakBytes: this.rssPeak
    };
  }
}

function stats(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 10) / 10
  };
}
