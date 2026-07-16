import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Setup relative path variables since we are using ESM modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5001;

// Enable CORS and JSON parsing middleware
app.use(cors());
app.use(express.json());

// Reference storage for our MCP Clients
let salesClient = null;
let telematicsClient = null;

/**
 * Initializes and connects to an MCP server using stdio transport.
 *
 * WHY: We need to spawn the MCP server as a subprocess and establish a
 * standard Stdio communication channel (stdin/stdout) so we can query its tools.
 * Using absolute paths via path.resolve ensures it runs correctly regardless of cwd.
 */
async function initMcpClient(command, serverPath, clientName) {
  try {
    const transport = new StdioClientTransport({
      command,
      args: [serverPath],
    });

    const client = new Client(
      {
        name: clientName,
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);
    console.log(`Connected to MCP Server: ${clientName} at ${serverPath}`);
    return client;
  } catch (error) {
    console.error(`Failed to initialize MCP client for ${clientName}:`, error);
    throw error;
  }
}

/**
 * Startup helper that connects to both MCP servers concurrently when the backend starts.
 *
 * WHY: Both MCP servers must be active and connected before the HTTP server starts
 * routing client requests, preventing null pointer exceptions during API calls.
 */
async function startMcpServices() {
  const salesPath = path.resolve(__dirname, "../mcp-servers/vehicle-sales/dist/index.js");
  const telematicsPath = path.resolve(__dirname, "../mcp-servers/vehicle-telematics/dist/index.js");

  console.log("Connecting to MCP servers...");
  salesClient = await initMcpClient("node", salesPath, "gateway-sales-client");
  telematicsClient = await initMcpClient("node", telematicsPath, "gateway-telematics-client");
}

/**
 * API route to query vehicle sales.
 *
 * WHY: This HTTP endpoint accepts queries from the React UI, validates/forwards
 * them to the Vehicle Sales MCP Server using the MCP 'callTool' protocol, and returns the result.
 */
app.get("/api/sales", async (req, res) => {
  if (!salesClient) {
    return res.status(500).json({ error: "Sales MCP Client is not connected" });
  }

  const { chassis_number, model_name, zone, limit } = req.query;

  try {
    // Call the MCP tool exposed by the Vehicle Sales server
    const result = await salesClient.callTool({
      name: "get_vehicle_sales",
      arguments: {
        chassis_number,
        model_name,
        zone,
        limit: limit ? parseInt(limit, 10) : undefined
      }
    });

    // Parse text content from MCP output format to JSON array
    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text);
      return res.json(data);
    }
    return res.json([]);
  } catch (error) {
    console.error("Error fetching sales via MCP:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * API route to get aggregated vehicle sales summary.
 *
 * WHY: Provides aggregated counts and revenue metrics to populate chart widgets
 * and summaries on the dashboard, calling the Sales MCP aggregation tool.
 */
app.get("/api/sales/summary", async (req, res) => {
  if (!salesClient) {
    return res.status(500).json({ error: "Sales MCP Client is not connected" });
  }

  const { group_by } = req.query;

  try {
    const result = await salesClient.callTool({
      name: "get_sales_summary",
      arguments: { group_by }
    });

    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text);
      return res.json(data);
    }
    return res.json([]);
  } catch (error) {
    console.error("Error fetching sales summary via MCP:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * API route to query vehicle telematics.
 *
 * WHY: Allows the dashboard to fetch real-time telemetry (SoC, speed, coords, temp)
 * from the Vehicle Telematics MCP server for a specific vehicle.
 */
app.get("/api/telematics", async (req, res) => {
  if (!telematicsClient) {
    return res.status(500).json({ error: "Telematics MCP Client is not connected" });
  }

  const { chassis_number, alert_flag, limit } = req.query;

  try {
    const result = await telematicsClient.callTool({
      name: "get_telematics_data",
      arguments: {
        chassis_number,
        alert_flag,
        limit: limit ? parseInt(limit, 10) : undefined
      }
    });

    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text);
      return res.json(data);
    }
    return res.json([]);
  } catch (error) {
    console.error("Error fetching telematics via MCP:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * API route to query vehicle faults.
 *
 * WHY: Exposes diagnostic fault codes, resolution states, and severity info
 * to the dashboard by calling the fault tool on the Telematics MCP server.
 */
app.get("/api/faults", async (req, res) => {
  if (!telematicsClient) {
    return res.status(500).json({ error: "Telematics MCP Client is not connected" });
  }

  const { chassis_number, severity, resolved_status, limit } = req.query;

  try {
    const result = await telematicsClient.callTool({
      name: "get_fault_codes",
      arguments: {
        chassis_number,
        severity,
        resolved_status,
        limit: limit ? parseInt(limit, 10) : undefined
      }
    });

    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text);
      return res.json(data);
    }
    return res.json([]);
  } catch (error) {
    console.error("Error fetching faults via MCP:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Starts the Express server and establishes links to the background MCP clients.
 *
 * WHY: Initiates HTTP server listener and prints confirmation when running.
 */
async function main() {
  try {
    await startMcpServices();
    app.listen(PORT, () => {
      console.log(`Express MCP Gateway running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Initialization error:", error);
    process.exit(1);
  }
}

main();
