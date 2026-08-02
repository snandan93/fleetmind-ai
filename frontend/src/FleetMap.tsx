import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

interface FleetMapRecord {
  _id?: string;
  chassis_number?: string;
  gps_latitude?: number;
  gps_longitude?: number;
  soc_percent?: number;
  speed_kmph?: number;
  vehicle_status?: string;
  charging_status?: string;
  alert_flag?: 'Yes' | 'No';
}

type StatusCategory = 'alert' | 'charging' | 'idle' | 'running';

const CATEGORY_COLOR: Record<StatusCategory, string> = {
  alert: '#ef4444',
  charging: '#3b82f6',
  idle: '#f59e0b',
  running: '#10b981',
};

function statusCategory(record: FleetMapRecord): StatusCategory {
  if (record.alert_flag === 'Yes') return 'alert';
  if (record.charging_status === 'Charging') return 'charging';
  if (record.vehicle_status === 'Idle') return 'idle';
  return 'running';
}

export default function FleetMap({ data }: { data: FleetMapRecord[] }) {
  const positioned = data.filter(
    (record): record is FleetMapRecord & { gps_latitude: number; gps_longitude: number } =>
      typeof record.gps_latitude === 'number' && typeof record.gps_longitude === 'number'
  );

  if (positioned.length === 0) {
    return <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No vehicle positions available.</div>;
  }

  const avgLat = positioned.reduce((sum, r) => sum + r.gps_latitude, 0) / positioned.length;
  const avgLng = positioned.reduce((sum, r) => sum + r.gps_longitude, 0) / positioned.length;

  const counts: Record<StatusCategory, number> = { alert: 0, charging: 0, idle: 0, running: 0 };
  for (const record of positioned) counts[statusCategory(record)]++;

  return (
    <div>
      <div style={{ height: '360px', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
        <MapContainer center={[avgLat, avgLng]} zoom={6} scrollWheelZoom={true} style={{ height: '100%', width: '100%' }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {positioned.map((record) => (
            <CircleMarker
              key={record._id ?? record.chassis_number}
              center={[record.gps_latitude, record.gps_longitude]}
              radius={7}
              pathOptions={{
                color: CATEGORY_COLOR[statusCategory(record)],
                fillColor: CATEGORY_COLOR[statusCategory(record)],
                fillOpacity: 0.85,
              }}
            >
              <Popup>
                <strong>{record.chassis_number}</strong>
                <br />
                SoC: {record.soc_percent ?? 'N/A'}% &middot; Speed: {record.speed_kmph ?? 'N/A'} km/h
                <br />
                Status: {record.vehicle_status ?? 'N/A'} &middot; Charging: {record.charging_status ?? 'N/A'}
                <br />
                Alert: {record.alert_flag === 'Yes' ? 'Triggered' : 'None'}
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
      <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem', flexWrap: 'wrap' }}>
        <span><span style={{ color: CATEGORY_COLOR.alert }}>●</span> Alert triggered ({counts.alert})</span>
        <span><span style={{ color: CATEGORY_COLOR.charging }}>●</span> Charging ({counts.charging})</span>
        <span><span style={{ color: CATEGORY_COLOR.idle }}>●</span> Idle ({counts.idle})</span>
        <span><span style={{ color: CATEGORY_COLOR.running }}>●</span> Running normally ({counts.running})</span>
        <span style={{ marginLeft: 'auto' }}>{positioned.length} vehicles shown</span>
      </div>
    </div>
  );
}
