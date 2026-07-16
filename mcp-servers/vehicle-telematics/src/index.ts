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
      severity: z.enum(["Major", "Minor", "Critical"]).optional(),
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
