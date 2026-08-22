/**
 * Per-stage timing aggregation: pages/sec, p50/p95 per stage, peak rss.
 * Sample arrays are bounded (latest MAX_SAMPLES kept) so a long-lived
 * service does not grow memory with every page; pagesPerSecond is only
 * meaningful for a continuous run — idle gaps between jobs deflate it.
 */
const MAX_SAMPLES = 5000;

export class Metrics {
  constructor() {
    this.stages = new Map();
    this.walls = [];
    this.pagesTotal = 0;
    this.rssPeak = 0;
    this.firstMs = undefined;
    this.lastMs = undefined;
  }

  record(jobId, stageTimingsMs, wallMs, rssBytes) {
    const now = Date.now();
    if (this.firstMs === undefined) this.firstMs = now;
    this.lastMs = now;
    this.pagesTotal += 1;
    push(this.walls, wallMs);
    if (rssBytes > this.rssPeak) this.rssPeak = rssBytes;
    for (const [stage, ms] of Object.entries(stageTimingsMs ?? {})) {
      if (!this.stages.has(stage)) this.stages.set(stage, []);
      push(this.stages.get(stage), ms);
    }
  }

  snapshot() {
    const stageStats = {};
    for (const [stage, samples] of this.stages) stageStats[stage] = stats(samples);
    const elapsedSec = this.firstMs === undefined ? 0 : Math.max(0.001, (this.lastMs - this.firstMs) / 1000);
    return {
      pagesMeasured: this.pagesTotal,
      samplesRetained: this.walls.length,
      // Continuous-run figure only: idle gaps between jobs deflate it.
      pagesPerSecond: this.pagesTotal < 2 ? null : Math.round((this.pagesTotal / elapsedSec) * 100) / 100,
      pageWallMs: stats(this.walls),
      stageMs: stageStats,
      workerRssPeakBytes: this.rssPeak
    };
  }
}

function push(samples, value) {
  samples.push(value);
  if (samples.length > MAX_SAMPLES) samples.shift();
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
