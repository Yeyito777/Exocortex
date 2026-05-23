#!/usr/bin/env bun

interface MetricReport {
  axis: string;
  workload: string;
  p95Ms: number;
}

interface BenchmarkReport {
  metrics: MetricReport[];
}

interface Options {
  json: boolean;
  maxRegressionRatio: number;
  minImprovementRatio: number;
  minGeomeanRatio: number;
  files: string[];
}

interface MetricComparison {
  key: string;
  ratios: number[];
  medianRatio: number;
  minRatio: number;
  maxRatio: number;
  controlMedianP95Ms: number;
  treatmentMedianP95Ms: number;
  percent: number;
}

interface InterleavedCompareReport {
  pairs: number;
  passed: boolean;
  p95GeomeanMedianRatio: number;
  comparisons: MetricComparison[];
  regressions: MetricComparison[];
  improvements: MetricComparison[];
  notes: string[];
}

const DEFAULT_MAX_REGRESSION_RATIO = 1.02;
const DEFAULT_MIN_IMPROVEMENT_RATIO = 0.95;
const DEFAULT_MIN_GEOMEAN_RATIO = 0.98;

function usage(): never {
  console.log(`Usage: bun run autoresearch/exocortex-performance/compare-interleaved.ts [--json] [--max-regression=1.02] [--min-improvement=0.95] [--min-geomean=0.98] control1.json treatment1.json [control2.json treatment2.json ...]\n\nCompares interleaved control/treatment benchmark runs using median p95 ratios per metric.`);
  process.exit(0);
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    json: false,
    maxRegressionRatio: DEFAULT_MAX_REGRESSION_RATIO,
    minImprovementRatio: DEFAULT_MIN_IMPROVEMENT_RATIO,
    minGeomeanRatio: DEFAULT_MIN_GEOMEAN_RATIO,
    files: [],
  };

  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") usage();
    else if (arg.startsWith("--max-regression=")) options.maxRegressionRatio = Number(arg.slice("--max-regression=".length));
    else if (arg.startsWith("--min-improvement=")) options.minImprovementRatio = Number(arg.slice("--min-improvement=".length));
    else if (arg.startsWith("--min-geomean=")) options.minGeomeanRatio = Number(arg.slice("--min-geomean=".length));
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.files.push(arg);
  }

  if (options.files.length < 2 || options.files.length % 2 !== 0) {
    throw new Error("Provide an even number of files: control1 treatment1 [control2 treatment2 ...]");
  }
  return options;
}

function keyFor(metric: Pick<MetricReport, "axis" | "workload">): string {
  return `${metric.axis}/${metric.workload}`;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function loadReport(path: string): Promise<BenchmarkReport> {
  return await Bun.file(path).json() as BenchmarkReport;
}

async function compareInterleaved(options: Options): Promise<InterleavedCompareReport> {
  const pairCount = options.files.length / 2;
  const controls: BenchmarkReport[] = [];
  const treatments: BenchmarkReport[] = [];
  for (let i = 0; i < options.files.length; i += 2) {
    controls.push(await loadReport(options.files[i]));
    treatments.push(await loadReport(options.files[i + 1]));
  }

  const firstControl = new Map(controls[0].metrics.map(metric => [keyFor(metric), metric]));
  const comparisons: MetricComparison[] = [];
  const notes: string[] = [];

  for (const key of firstControl.keys()) {
    const ratios: number[] = [];
    const controlP95s: number[] = [];
    const treatmentP95s: number[] = [];
    let missing = false;

    for (let i = 0; i < pairCount; i++) {
      const control = new Map(controls[i].metrics.map(metric => [keyFor(metric), metric]));
      const treatment = new Map(treatments[i].metrics.map(metric => [keyFor(metric), metric]));
      const base = control.get(key);
      const current = treatment.get(key);
      if (!base || !current) {
        notes.push(`Missing metric ${key} in pair ${i + 1}`);
        missing = true;
        break;
      }
      controlP95s.push(base.p95Ms);
      treatmentP95s.push(current.p95Ms);
      ratios.push(current.p95Ms / Math.max(0.001, base.p95Ms));
    }

    if (missing) continue;
    const medianRatio = median(ratios);
    comparisons.push({
      key,
      ratios: ratios.map(round),
      medianRatio: round(medianRatio),
      minRatio: round(Math.min(...ratios)),
      maxRatio: round(Math.max(...ratios)),
      controlMedianP95Ms: round(median(controlP95s)),
      treatmentMedianP95Ms: round(median(treatmentP95s)),
      percent: round((medianRatio - 1) * 100),
    });
  }

  const regressions = comparisons.filter(c => c.medianRatio > options.maxRegressionRatio);
  const improvements = comparisons.filter(c => c.medianRatio <= options.minImprovementRatio);
  const p95GeomeanMedianRatio = comparisons.length === 0
    ? 1
    : Math.exp(comparisons.reduce((sum, c) => sum + Math.log(c.medianRatio), 0) / comparisons.length);
  const passed = regressions.length === 0 && (improvements.length > 0 || p95GeomeanMedianRatio <= options.minGeomeanRatio);

  if (regressions.length > 0) notes.push(`${regressions.length} median p95 regression(s) exceed ${round((options.maxRegressionRatio - 1) * 100)}%.`);
  if (improvements.length === 0 && p95GeomeanMedianRatio > options.minGeomeanRatio) notes.push("No targeted median p95 improvement >= 5% and geomean median p95 improvement < 2%.");

  return {
    pairs: pairCount,
    passed,
    p95GeomeanMedianRatio: round(p95GeomeanMedianRatio),
    comparisons,
    regressions: [...regressions].sort((a, b) => b.medianRatio - a.medianRatio),
    improvements: [...improvements].sort((a, b) => a.medianRatio - b.medianRatio),
    notes,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const report = await compareInterleaved(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`pairs=${report.pairs} passed=${report.passed} geomeanMedian=${report.p95GeomeanMedianRatio.toFixed(3)}`);
    for (const c of report.comparisons) {
      const interesting = c.medianRatio > options.maxRegressionRatio || c.medianRatio <= options.minImprovementRatio;
      if (interesting) console.log(`${c.key.padEnd(70)} median=${c.medianRatio.toFixed(3)} ratios=${c.ratios.map(r => r.toFixed(3)).join(" ")}`);
    }
    for (const note of report.notes) console.log(`note: ${note}`);
  }
  if (!report.passed) process.exitCode = 2;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
