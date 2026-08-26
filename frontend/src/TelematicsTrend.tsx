interface TrendRecord {
  _id?: string;
  reading_timestamp?: string;
  soc_percent?: number;
  speed_kmph?: number;
  battery_temp_c?: number;
  alert_flag?: 'Yes' | 'No';
}

interface MetricConfig {
  key: 'soc_percent' | 'speed_kmph' | 'battery_temp_c';
  label: string;
  unit: string;
  color: string;
}

const METRICS: MetricConfig[] = [
  { key: 'soc_percent', label: 'Battery SoC', unit: '%', color: '#10b981' },
  { key: 'speed_kmph', label: 'Speed', unit: 'km/h', color: '#3b82f6' },
  { key: 'battery_temp_c', label: 'Battery Temp', unit: '°C', color: '#f59e0b' },
];

const CHART_WIDTH = 600;
const CHART_HEIGHT = 90;
const PAD_X = 6;
const PAD_Y = 10;

function LineChart({ records, metric }: { records: TrendRecord[]; metric: MetricConfig }) {
  const values = records.map((r) => r[metric.key] ?? 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const usableWidth = CHART_WIDTH - PAD_X * 2;
  const usableHeight = CHART_HEIGHT - PAD_Y * 2;

  const points = records.map((record, i) => {
    const value = values[i] ?? 0;
    const x = records.length > 1 ? PAD_X + (i / (records.length - 1)) * usableWidth : CHART_WIDTH / 2;
    const y = PAD_Y + usableHeight - ((value - min) / range) * usableHeight;
    return { x, y, value, alert: record.alert_flag === 'Yes' };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{metric.label}</span>
        <span>min {min.toFixed(1)}{metric.unit} &middot; max {max.toFixed(1)}{metric.unit}</span>
      </div>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} style={{ width: '100%', height: '80px', display: 'block' }}>
        <path d={pathD} fill="none" stroke={metric.color} strokeWidth={2} />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={p.alert ? 3.5 : 2.5}
            fill={p.alert ? '#ef4444' : metric.color}
          />
        ))}
      </svg>
    </div>
  );
}

export default function TelematicsTrend({ data }: { data: TrendRecord[] }) {
  if (data.length === 0) {
    return <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No telematics history found for this vehicle.</div>;
  }

  // Backend returns newest-first; charts read left (oldest) to right (newest).
  const chronological = [...data].reverse();
  const alertCount = chronological.filter((r) => r.alert_flag === 'Yes').length;

  return (
    <div>
      {METRICS.map((metric) => (
        <LineChart key={metric.key} records={chronological} metric={metric} />
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
        <span>{chronological[0]?.reading_timestamp}</span>
        <span>{chronological.length} readings{alertCount > 0 ? ` · ${alertCount} with alerts (red dots)` : ''}</span>
        <span>{chronological[chronological.length - 1]?.reading_timestamp}</span>
      </div>
    </div>
  );
}
