// Sample-data seeder for FleetMind AI.
//
// Run manually against an existing MongoDB instance:
//   mongosh "<your MONGO_URI>/ev_sales_db" scripts/seed.js
//
// Or let Docker run it automatically on first boot — see docker-compose.yml,
// which mounts this file into /docker-entrypoint-initdb.d.
//
// Resets and repopulates vehicle_sales, telematics_data, and fault_codes
// with a small, internally-consistent fleet so the app works out of the box.

const sales = db.getSiblingDB("ev_sales_db");

const VERTICALS = [
  { code: "3W", label: "3-Wheeler", models: ["e-Cargo Mini", "e-Cargo Plus"] },
  { code: "SCV", label: "Small Commercial Vehicle", models: ["e-SCV 1000", "e-SCV 1500"] },
  { code: "HCV", label: "Heavy Commercial Vehicle", models: ["e-HCV 5000", "e-HCV 7500"] },
  { code: "TRACTOR", label: "Tractor", models: ["e-Trac 40", "e-Trac 60"] },
];

const ZONES = ["North", "South", "East", "West"];
const DEALERS = ["Capital Motors", "Coastal EV Hub", "Highway Fleet Sales", "Metro Auto Point"];
const CUSTOMER_TYPES = ["Individual", "Fleet Operator", "Corporate"];
const PAYMENT_MODES = ["Cash", "Loan", "Lease"];
const SALE_STATUSES = ["Completed", "Completed", "Completed", "Pending"];
const FAULT_CATALOG = [
  { code: "BMS-104", component: "Battery Management System" },
  { code: "MOT-221", component: "Traction Motor" },
  { code: "CHG-317", component: "Onboard Charger" },
  { code: "BRK-052", component: "Regenerative Braking" },
  { code: "TEL-088", component: "Telematics Unit" },
];
const SEVERITIES = ["Warning", "Minor", "Major", "Critical"];

// A few real Indian metro clusters so map/location queries look plausible.
const CITY_CLUSTERS = [
  { lat: 28.61, lng: 77.23 }, // Delhi NCR
  { lat: 19.08, lng: 72.88 }, // Mumbai
  { lat: 12.97, lng: 77.59 }, // Bengaluru
  { lat: 13.08, lng: 80.27 }, // Chennai
  { lat: 23.26, lng: 77.41 }, // Bhopal
];

const VEHICLES_PER_VERTICAL = 10;
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randFloat = (min, max, decimals = 1) => Number((min + Math.random() * (max - min)).toFixed(decimals));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const fmtDate = (d) => d.toISOString().slice(0, 10);
const fmtTimestamp = (d) => d.toISOString().slice(0, 19).replace("T", " ");

const salesDocs = [];
const telematicsDocs = [];
const faultDocs = [];

VERTICALS.forEach((vertical) => {
  for (let i = 1; i <= VEHICLES_PER_VERTICAL; i++) {
    const chassisNumber = `${vertical.code}2600${String(i).padStart(4, "0")}`;
    const model = rand(vertical.models);
    const basePrice = { "3W": 350000, SCV: 950000, HCV: 3200000, TRACTOR: 1400000 }[vertical.code];

    salesDocs.push({
      chassis_number: chassisNumber,
      model_name: model,
      vertical: vertical.code,
      vertical_label: vertical.label,
      dealer_name: rand(DEALERS),
      zone: rand(ZONES),
      sale_date: fmtDate(daysAgo(randInt(5, 200))),
      customer_name: `Customer ${chassisNumber.slice(-4)}`,
      customer_type: rand(CUSTOMER_TYPES),
      payment_mode: rand(PAYMENT_MODES),
      ex_showroom_price_inr: basePrice + randInt(-40000, 60000),
      battery_capacity_kwh: randFloat(15, 120),
      motor_power_kw: randFloat(10, 180),
      warranty_years: rand([3, 5, 8]),
      salesperson_name: `Agent ${randInt(1, 12)}`,
      sale_status: rand(SALE_STATUSES),
    });

    // 1-3 telematics readings per vehicle, newest last insert but any order is
    // fine since queries sort by reading_timestamp.
    const cluster = rand(CITY_CLUSTERS);
    const readingCount = randInt(1, 3);
    const hasAlert = Math.random() < 0.15;

    for (let r = 0; r < readingCount; r++) {
      const isLatest = r === readingCount - 1;
      const alertFlag = isLatest && hasAlert ? "Yes" : "No";
      const socPercent = randInt(8, 100);
      const charging = socPercent < 30 && Math.random() < 0.4;

      telematicsDocs.push({
        chassis_number: chassisNumber,
        vertical: vertical.code,
        reading_timestamp: fmtTimestamp(daysAgo(readingCount - r) ),
        gps_latitude: Number((cluster.lat + randFloat(-0.4, 0.4, 4)).toFixed(4)),
        gps_longitude: Number((cluster.lng + randFloat(-0.4, 0.4, 4)).toFixed(4)),
        speed_kmph: charging ? 0 : randInt(0, 70),
        odometer_km: randFloat(50, 45000, 1),
        soc_percent: socPercent,
        battery_temp_c: randFloat(28, 48),
        motor_temp_c: randFloat(30, 70),
        ignition_status: charging ? "OFF" : rand(["ON", "OFF"]),
        charging_status: charging ? "Charging" : "Not Charging",
        range_remaining_km: randFloat(15, 260),
        energy_consumption_kwh_per_km: randFloat(0.08, 0.9, 3),
        vehicle_status: charging ? "Idle" : rand(["Running", "Idle"]),
        alert_flag: alertFlag,
      });
    }

    // ~40% of vehicles have 1-2 fault records.
    if (Math.random() < 0.4) {
      const faultCount = randInt(1, 2);
      for (let f = 0; f < faultCount; f++) {
        const fault = rand(FAULT_CATALOG);
        const severity = rand(SEVERITIES);
        const resolved = Math.random() < 0.6;
        faultDocs.push({
          chassis_number: chassisNumber,
          fault_code: fault.code,
          component: fault.component,
          severity,
          downtime_hours: randFloat(0.5, 48),
          cost_of_repair_inr: randInt(1500, 45000),
          resolved_status: resolved ? "Resolved" : "In Progress",
          detected_timestamp: fmtTimestamp(daysAgo(randInt(1, 90))),
        });
      }
    }
  }
});

sales.vehicle_sales.drop();
sales.telematics_data.drop();
sales.fault_codes.drop();

sales.vehicle_sales.insertMany(salesDocs);
sales.telematics_data.insertMany(telematicsDocs);
sales.fault_codes.insertMany(faultDocs);

print(`Seeded ${salesDocs.length} sales records`);
print(`Seeded ${telematicsDocs.length} telematics readings`);
print(`Seeded ${faultDocs.length} fault records`);
