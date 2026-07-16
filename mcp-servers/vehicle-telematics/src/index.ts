import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Document, type Filter, MongoClient } from "mongodb";
import { z } from "zod";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));

try {
  loadEnvFile(envPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = z
  .object({
    MONGO_URI: z.string().min(1, "MONGO_URI is required"),
    MONGO_DB_NAME: z.string().min(1).default("ev_sales_db"),
    TELEMATICS_COLLECTION: z.string().min(1).default("telematics_data"),
    FAULTS_COLLECTION: z.string().min(1).default("fault_codes"),
  })
  .parse(process.env);

const mongoClient = new MongoClient(config.MONGO_URI, {
  serverSelectionTimeoutMS: 5_000,
});
let databasePromise: ReturnType<typeof connectToDatabase> | undefined;

async function connectToDatabase() {
  await mongoClient.connect();
  console.error("Vehicle Telematics MCP connected to MongoDB");
  return mongoClient.db(config.MONGO_DB_NAME);
}

function database() {
  databasePromise ??= connectToDatabase().catch((error) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const limitSchema = z.number().int().min(1).max(100).default(20);
const severitySchema = z.enum(["Warning", "Minor", "Major", "Critical"]);
const faultGroupBySchema = z.enum(["chassis_number", "fault_code", "component"]).default("chassis_number");
const server = new McpServer({ name: "vehicle-telematics-server", version: "2.0.0" });

server.registerTool(
  "get_telematics_data",
  {
    title: "Get vehicle telematics data",
    description: "Fetch recent vehicle telemetry such as battery, speed, and location.",
    inputSchema: {
      chassis_number: z.string().trim().min(1).optional(),
      alert_flag: z.enum(["Yes", "No"]).optional(),
      limit: limitSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ chassis_number, alert_flag, limit }) => {
    const query: Filter<Document> = {
      ...(chassis_number && { chassis_number }),
      ...(alert_flag && { alert_flag }),
    };
    const records = await (await database())
      .collection(config.TELEMATICS_COLLECTION)
      .find(query)
      .sort({ reading_timestamp: -1 })
      .limit(limit)
      .toArray();
    return textResult(records);
  },
);

server.registerTool(
  "get_fault_codes",
  {
    title: "Get vehicle fault codes",
    description: "Fetch recent vehicle fault codes and maintenance records.",
    inputSchema: {
      chassis_number: z.string().trim().min(1).optional(),
      severity: severitySchema.optional(),
      resolved_status: z.enum(["Resolved", "In Progress"]).optional(),
      limit: limitSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ chassis_number, severity, resolved_status, limit }) => {
    const query: Filter<Document> = {
      ...(chassis_number && { chassis_number }),
      ...(severity && { severity }),
      ...(resolved_status && { resolved_status }),
    };
    const records = await (await database())
      .collection(config.FAULTS_COLLECTION)
      .find(query)
      .sort({ detected_timestamp: -1 })
      .limit(limit)
      .toArray();
    return textResult(records);
  },
);

server.registerTool(
  "get_fault_summary",
  {
    title: "Get fault code summary",
    description:
      "Aggregate fault counts and repair cost across the whole fleet, grouped by chassis, fault code, or component. Use this (not get_fault_codes) to answer questions like 'which vehicle has the most critical alerts' or 'most common fault codes' — it counts across all matching records instead of returning a capped raw list.",
    inputSchema: {
      group_by: faultGroupBySchema,
      severity: severitySchema.optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ group_by, severity }) => {
    const summary = await (await database())
      .collection(config.FAULTS_COLLECTION)
      .aggregate([
        ...(severity ? [{ $match: { severity } }] : []),
        {
          $group: {
            _id: `$${group_by}`,
            total_faults: { $sum: 1 },
            critical_count: { $sum: { $cond: [{ $eq: ["$severity", "Critical"] }, 1, 0] } },
            major_count: { $sum: { $cond: [{ $eq: ["$severity", "Major"] }, 1, 0] } },
            total_repair_cost_inr: { $sum: "$cost_of_repair_inr" },
          },
        },
        { $sort: { critical_count: -1, total_faults: -1 } },
        { $limit: 50 },
      ])
      .toArray();
    return textResult(summary);
  },
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`Received ${signal}; shutting down Vehicle Telematics MCP`);
  await Promise.allSettled([server.close(), mongoClient.close()]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await server.connect(new StdioServerTransport());
console.error("Vehicle Telematics MCP is listening on stdio");
