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
    SALES_COLLECTION: z.string().min(1).default("vehicle_sales"),
  })
  .parse(process.env);

const mongoClient = new MongoClient(config.MONGO_URI, {
  serverSelectionTimeoutMS: 5_000,
});
let databasePromise: ReturnType<typeof connectToDatabase> | undefined;

async function connectToDatabase() {
  await mongoClient.connect();
  console.error("Vehicle Sales MCP connected to MongoDB");
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
const groupBySchema = z
  .enum(["model_name", "zone", "customer_type", "payment_mode"])
  .default("model_name");
const server = new McpServer({ name: "vehicle-sales-server", version: "2.0.0" });

server.registerTool(
  "get_vehicle_sales",
  {
    title: "Get vehicle sales",
    description: "Fetch recent vehicle sales records with optional filters.",
    inputSchema: {
      chassis_number: z.string().trim().min(1).optional(),
      model_name: z.string().trim().min(1).optional(),
      zone: z.string().trim().min(1).optional(),
      limit: limitSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ chassis_number, model_name, zone, limit }) => {
    const query: Filter<Document> = {
      ...(chassis_number && { chassis_number }),
      ...(model_name && { model_name }),
      ...(zone && { zone }),
    };
    const records = await (await database())
      .collection(config.SALES_COLLECTION)
      .find(query)
      .sort({ sale_date: -1, _id: -1 })
      .limit(limit)
      .toArray();
    return textResult(records);
  },
);

server.registerTool(
  "get_sales_summary",
  {
    title: "Get sales summary",
    description: "Aggregate sales count, revenue, and average price by a supported field.",
    inputSchema: { group_by: groupBySchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ group_by }) => {
    const summary = await (await database())
      .collection(config.SALES_COLLECTION)
      .aggregate([
        {
          $group: {
            _id: `$${group_by}`,
            total_sales: { $sum: 1 },
            total_revenue_inr: { $sum: "$ex_showroom_price_inr" },
            avg_price_inr: { $avg: "$ex_showroom_price_inr" },
          },
        },
        { $sort: { total_sales: -1 } },
      ])
      .toArray();
    return textResult(summary);
  },
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`Received ${signal}; shutting down Vehicle Sales MCP`);
  await Promise.allSettled([server.close(), mongoClient.close()]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await server.connect(new StdioServerTransport());
console.error("Vehicle Sales MCP is listening on stdio");
