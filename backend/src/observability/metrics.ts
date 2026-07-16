/**
 * Prometheus 메트릭 레지스트리 — 기획서 9.3.
 * 외부 의존성 없이 counter/gauge/summary + text 노출 포맷. `GET /metrics`로 서빙.
 */

type Labels = Readonly<Record<string, string | number>>;

function labelKey(labels: Labels): string {
  const parts = Object.keys(labels).sort().map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

interface Summary { sum: number; count: number }

export class Metrics {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly summaries = new Map<string, Map<string, Summary>>();
  private readonly help = new Map<string, string>();

  describe(name: string, help: string): void { this.help.set(name, help); }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const m = this.counters.get(name) ?? new Map();
    const k = labelKey(labels);
    m.set(k, (m.get(k) ?? 0) + by);
    this.counters.set(name, m);
  }
  setGauge(name: string, value: number, labels: Labels = {}): void {
    const m = this.gauges.get(name) ?? new Map();
    m.set(labelKey(labels), value);
    this.gauges.set(name, m);
  }
  observe(name: string, value: number, labels: Labels = {}): void {
    const m = this.summaries.get(name) ?? new Map();
    const k = labelKey(labels);
    const s = m.get(k) ?? { sum: 0, count: 0 };
    s.sum += value; s.count += 1;
    m.set(k, s);
    this.summaries.set(name, m);
  }

  /** Prometheus 텍스트 노출 포맷. */
  render(): string {
    const lines: string[] = [];
    const emitHelp = (name: string, type: string) => {
      const h = this.help.get(name);
      if (h) lines.push(`# HELP ${name} ${h}`);
      lines.push(`# TYPE ${name} ${type}`);
    };
    for (const [name, m] of this.counters) {
      emitHelp(name, "counter");
      for (const [k, v] of m) lines.push(`${name}${k} ${v}`);
    }
    for (const [name, m] of this.gauges) {
      emitHelp(name, "gauge");
      for (const [k, v] of m) lines.push(`${name}${k} ${v}`);
    }
    for (const [name, m] of this.summaries) {
      emitHelp(name, "summary");
      for (const [k, s] of m) {
        lines.push(`${name}_sum${k} ${s.sum}`);
        lines.push(`${name}_count${k} ${s.count}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}

/** 서버 표준 지표 이름(9.3). */
export const METRIC = {
  publishTotal: "rynl10n_publish_total", // labels: result=success|conflict|error
  publishDuration: "rynl10n_publish_duration_seconds",
  apiRequests: "rynl10n_api_requests_total", // labels: method, route, status
  apiDuration: "rynl10n_api_request_duration_seconds",
  telemetryEvents: "rynl10n_telemetry_events_total", // labels: event
  storageBytes: "rynl10n_storage_bytes",
  releasesTotal: "rynl10n_releases_total",
} as const;
