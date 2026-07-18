import express, { type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { loadEnvFile } from "process";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { MCPToolset, type BaseTool } from "@google/adk";
import type { FunctionDeclaration } from "@google/generative-ai";

// Setup relative path variables since we are using ESM modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const workspaceDir = path.resolve(backendDir, "..");
const childProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

interface ChatHistoryMessage {
  sender: "user" | "assistant";
  text?: string;
  toolCall?: unknown;
  widget?: unknown;
}

interface ChatRequestBody {
  message?: string;
  history?: ChatHistoryMessage[];
}

interface McpTextResult {
  content: Array<{ text: string }>;
}

interface ServiceError extends Error {
  status?: number;
}

function errorDetails(error: unknown): ServiceError {
  return error instanceof Error ? error as ServiceError : new Error(String(error));
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function queryInteger(value: unknown): number | undefined {
  const stringValue = queryString(value);
  if (!stringValue) return undefined;
  const parsed = Number.parseInt(stringValue, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toolResultText(result: unknown): string {
  const candidate = result as Partial<McpTextResult>;
  const text = candidate.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("MCP tool returned an invalid text result");
  }
  return text;
}

async function runTool(tool: BaseTool, args: Record<string, unknown>): Promise<string> {
  const result = await tool.runAsync({
    args,
    // MCP tools only read the abort signal from this boundary today. ADK's
    // public type expects a full Context, which is supplied by Runner-based agents.
    toolContext: { abortSignal: undefined } as never,
  });
  return toolResultText(result);
}

// Load env files from typical locations to be extremely robust
const envPaths = [
  path.resolve(backendDir, ".env"),
  path.resolve(workspaceDir, ".env"),
  path.resolve(workspaceDir, "mcp-servers/vehicle-sales/.env"),
  path.resolve(workspaceDir, "mcp-servers/vehicle-telematics/.env")
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    try {
      loadEnvFile(envPath);
      console.log(`Loaded environment file from: ${envPath}`);
    } catch (err) {
      console.error(`Error loading env file ${envPath}:`, err);
    }
  }
}

const app = express();
const PORT = Number.parseInt(process.env.PORT ?? "5001", 10);

// Enable CORS and JSON parsing middleware
app.use(cors());
app.use(express.json());

// Reference storage for our ADK MCP Toolsets and tools
let salesToolset: MCPToolset | null = null;
let telematicsToolset: MCPToolset | null = null;
let salesTools: BaseTool[] = [];
let telematicsTools: BaseTool[] = [];

// Initialize the Google GenAI SDK if API key is present
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let genAI: GoogleGenerativeAI | null = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  console.log("Google Generative AI SDK initialized successfully.");
} else {
  console.warn("WARNING: GEMINI_API_KEY is not configured in the environment. Conversational assistant will run in fallback mode.");
}

/**
 * Startup helper that connects to both MCP servers concurrently using Google ADK MCPToolset.
 *
 * WHY: ADK's MCPToolset automatically connects, manages the child process, and retrieves
 * the list of available tools, resolving them into standard ADK BaseTool instances.
 */
async function startMcpServices() {
  const salesPath = path.resolve(workspaceDir, "mcp-servers/vehicle-sales/dist/index.js");
  const telematicsPath = path.resolve(workspaceDir, "mcp-servers/vehicle-telematics/dist/index.js");

  console.log("Connecting to MCP servers via Google ADK...");

  salesToolset = new MCPToolset({
    type: 'StdioConnectionParams',
    serverParams: {
      command: 'node',
      args: [salesPath],
      env: childProcessEnv
    }
  });

  telematicsToolset = new MCPToolset({
    type: 'StdioConnectionParams',
    serverParams: {
      command: 'node',
      args: [telematicsPath],
      env: childProcessEnv
    }
  });

  salesTools = await salesToolset.getTools();
  telematicsTools = await telematicsToolset.getTools();

  console.log(`Successfully connected. Retrieved ${salesTools.length} Sales tools and ${telematicsTools.length} Telematics tools.`);
}

/**
 * Gets Gemini Function Declarations from ADK tool instances.
 *
 * WHY: ADK tools natively expose a `_getDeclaration()` method that automatically
 * formats schemas into uppercase and strips metadata variables.
 */
function getGeminiToolDeclarations() {
  const salesDeclarations = salesTools.map((tool) => tool._getDeclaration()).filter((declaration) => declaration !== undefined);
  const telematicsDeclarations = telematicsTools.map((tool) => tool._getDeclaration()).filter((declaration) => declaration !== undefined);
  return [...salesDeclarations, ...telematicsDeclarations];
}

/**
 * Intent classification guardrail function (belt-and-suspenders).
 *
 * WHY: ADK/agent best practices suggest classifying user queries and short-circuiting
 * off-topic requests before invoking the LLM, restricting responses to EV sales,
 * faults, diagnostics, and telematics.
 */
function scopeGuardrail(userText: string): string | null {
  const normalizedText = userText.toLowerCase();
  const offTopicSignals = ["weather", "joke", "write code", "translate", "recipe", "song", "movie", "calculate"];

  if (offTopicSignals.some(signal => normalizedText.includes(signal))) {
    return "I am Montra Electric's EV commercial vehicle specialist assistant. I handle EV sales, vehicle fault diagnostics, DTC lookups, and telematics or battery queries. Please ask an EV sales question or share a chassis number or fault code.";
  }
  return null;
}

/**
 * REST API route to route conversational queries through Gemini LLM with MCP tool-calling.
 *
 * WHY: Acts as the primary agent endpoint. Receives user prompts, submits them to Gemini
 * along with the MCP tool schemas, runs the tool-calling loop against MongoDB, feeds back
 * results, and returns the final conversational response + logs to the frontend.
 */
app.post("/api/chat", async (req: Request<Record<string, never>, unknown, ChatRequestBody>, res: Response) => {
  const { message, history = [] } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message query is required" });
  }

  // 1. Run guardrail check first to reject off-topic conversations immediately
  const guardrailReply = scopeGuardrail(message);
  if (guardrailReply) {
    return res.json({
      text: guardrailReply,
      toolCalls: []
    });
  }

  // Fallback if the user has not configured their Gemini API key
  if (!genAI) {
    return res.json({
      text: "The Gemini API Key is not configured on this server. Please set the **GEMINI_API_KEY** environment variable in your terminal (e.g. `export GEMINI_API_KEY=AIzaSy...`) and restart the application to enable intelligent conversational search.",
      toolCalls: []
    });
  }

  try {
    // 2. Get dynamic tool definitions from our ADK tools
    const toolDeclarations = getGeminiToolDeclarations();

    // 3. Initialize Gemini 2.5 Flash with strict, locked system instructions
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      // ADK currently emits declarations from @google/genai while this legacy
      // Gemini client consumes the structurally equivalent SDK declaration.
      tools: [{ functionDeclarations: toolDeclarations as unknown as FunctionDeclaration[] }],
      systemInstruction: `You are a specialist sales and vehicle-operations agent for Montra Electric EV commercial vehicles.
You handle:
- EV sales records and analysis (sales by model, zone, customer type, payment mode, revenue, pricing, and vehicle sale details)
- Vehicle fault code / DTC analysis (e.g. "Top Faults", fault history)
- Telematics data queries (location, battery SoC/SoH, trip data, alerts)
- EV-specific diagnostics (battery, motor, BMS, charging faults)

You do NOT answer questions unrelated to these topics (general chat, non-EV vehicles, unrelated company info, etc.). If asked something out of scope, politely say this agent is scoped to EV sales, fault diagnostics, and telematics analysis, and ask for an EV sales question, chassis number, or fault code instead.

For sales questions about individual vehicles or filtered sales records, use get_vehicle_sales. For sales totals, rankings, revenue, average price, or comparisons across models, zones, customer types, or payment modes, use get_sales_summary. Never infer fleet-wide sales totals from a capped get_vehicle_sales result.

For a telematics question about a specific chassis, return only the latest reading by default and call get_telematics_data with limit 1. Request multiple readings only when the user explicitly asks for history, previous readings, a trend, or a time-based comparison. Present a single latest reading as the vehicle's current snapshot, not as "Record 1".

If the user asks about faults without providing a chassis number, execute the fault query tool WITHOUT a chassis number filter to fetch recent vehicle faults across the entire fleet, identify the top/most common fault codes among all vehicles, and display them.

For any question that requires counting, ranking, or comparing across the whole fleet (e.g. "which vehicle has the most critical alerts", "top fault codes", "most repair cost by component"), use the get_fault_summary tool (group_by chassis_number / fault_code / component) instead of get_fault_codes — get_fault_codes only returns a capped raw list and cannot be used to determine fleet-wide counts or rankings. Never tell the user you are unable to aggregate; call get_fault_summary and answer from its results.`
    });

    // 3. Map pure text message history for conversation context (ignoring raw data widgets to prevent token overflow)
    const textHistory = history
      .filter((msg): msg is ChatHistoryMessage & { text: string } => Boolean(msg.text) && !msg.toolCall && !msg.widget)
      .map((msg) => ({
        role: msg.sender === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      }));

    // Ensure the chat history starts with a 'user' role as required by Gemini
    if (textHistory.at(0)?.role === 'model') {
      textHistory.shift();
    }

    // 4. Start chat session
    const chat = model.startChat({
      history: textHistory
    });

    // 5. Send user message to start tool-calling loop
    let response = await chat.sendMessage(message);
    let currentCalls = response.response.functionCalls();
    const toolCallsMade = [];

    // 6. Execute function calls requested by the model, feed back results, and loop
    while (currentCalls && currentCalls.length > 0) {
      const functionResponses = [];

      for (const call of currentCalls) {
        const { name, args } = call;
        console.log(`Gemini requested tool call: ${name} with args:`, args);

        let serverName = "";

        // Find the matching ADK tool
        const allTools = [...salesTools, ...telematicsTools];
        const tool = allTools.find(t => t.name === name);
        if (!tool) {
          throw new Error(`Unknown function call requested: ${name}`);
        }

        if (name === "get_vehicle_sales" || name === "get_sales_summary") {
          serverName = "vehicle-sales-server";
        } else {
          serverName = "vehicle-telematics-server";
        }

        // Run the tool via Google ADK runAsync
        const resultText = await runTool(tool, args as Record<string, unknown>);
        const parsedData = JSON.parse(resultText);

        // Store log details so the UI can render rich interactive visual widgets
        toolCallsMade.push({
          server: serverName,
          tool: name,
          arguments: args,
          data: parsedData
        });

        // Push function response back into Gemini input timeline
        functionResponses.push({
          functionResponse: {
            name,
            response: { result: resultText }
          }
        });
      }

      // Send the tool results to Gemini to let it compile the next turn
      const nextResponse = await chat.sendMessage(functionResponses);
      currentCalls = nextResponse.response.functionCalls();
      response = nextResponse;
    }

    // Return the final conversational text and the array of data widgets
    return res.json({
      text: response.response.text(),
      toolCalls: toolCallsMade
    });

  } catch (error: unknown) {
    console.error("Error in Gemini /api/chat gateway agent:", error);
    const serviceError = errorDetails(error);

    // Catch 429 quota/rate limit error and return a user-friendly suggestion
    if (serviceError.status === 429 || serviceError.message.includes("429") || serviceError.message.includes("Quota")) {
      return res.json({
        text: "⚠️ **Gemini API Rate Limit Exceeded (429: Too Many Requests)**. Your API key has temporarily hit its quota limit. Please wait a few seconds and try your query again.",
        toolCalls: []
      });
    }

    // Catch transient Gemini overload/outage errors and return a user-friendly suggestion
    // instead of a generic 500, which the frontend otherwise reports as "gateway is down".
    if (serviceError.status === 503 || serviceError.status === 500 || serviceError.message.includes("503") || serviceError.message.includes("overloaded") || serviceError.message.includes("high demand")) {
      return res.json({
        text: "⚠️ **Gemini API Temporarily Unavailable (503)**. Google's model is experiencing high demand right now. This is not a problem with the FleetMind gateway — please wait a few seconds and try again.",
        toolCalls: []
      });
    }

    return res.status(500).json({ error: serviceError.message });
  }
});

/**
 * API route to query vehicle sales.
 *
 * WHY: This HTTP endpoint accepts queries from the React UI, validates/forwards
 * them to the Vehicle Sales MCP Server using the MCP 'callTool' protocol, and returns the result.
 */
app.get("/api/sales", async (req: Request, res: Response) => {
  if (salesTools.length === 0) {
    return res.status(500).json({ error: "Sales MCP tools are not loaded" });
  }

  const { chassis_number, model_name, zone, limit } = req.query;

  try {
    const tool = salesTools.find(t => t.name === "get_vehicle_sales");
    if (!tool) throw new Error("Tool get_vehicle_sales not found");

    const resultText = await runTool(tool, {
      chassis_number: queryString(chassis_number),
      model_name: queryString(model_name),
      zone: queryString(zone),
      limit: queryInteger(limit),
    });
    return res.json(JSON.parse(resultText));
  } catch (error: unknown) {
    console.error("Error fetching sales via ADK:", error);
    res.status(500).json({ error: errorDetails(error).message });
  }
});

app.get("/api/sales/summary", async (req: Request, res: Response) => {
  if (salesTools.length === 0) {
    return res.status(500).json({ error: "Sales MCP tools are not loaded" });
  }

  const { group_by } = req.query;

  try {
    const tool = salesTools.find(t => t.name === "get_sales_summary");
    if (!tool) throw new Error("Tool get_sales_summary not found");

    const resultText = await runTool(tool, { group_by: queryString(group_by) });
    return res.json(JSON.parse(resultText));
  } catch (error: unknown) {
    console.error("Error fetching sales summary via ADK:", error);
    res.status(500).json({ error: errorDetails(error).message });
  }
});

app.get("/api/telematics", async (req: Request, res: Response) => {
  if (telematicsTools.length === 0) {
    return res.status(500).json({ error: "Telematics MCP tools are not loaded" });
  }

  const { chassis_number, alert_flag, limit } = req.query;

  try {
    const tool = telematicsTools.find(t => t.name === "get_telematics_data");
    if (!tool) throw new Error("Tool get_telematics_data not found");

    const resultText = await runTool(tool, {
      chassis_number: queryString(chassis_number),
      alert_flag: queryString(alert_flag),
      limit: queryInteger(limit),
    });
    return res.json(JSON.parse(resultText));
  } catch (error: unknown) {
    console.error("Error fetching telematics via ADK:", error);
    res.status(500).json({ error: errorDetails(error).message });
  }
});

app.get("/api/faults", async (req: Request, res: Response) => {
  if (telematicsTools.length === 0) {
    return res.status(500).json({ error: "Telematics MCP tools are not loaded" });
  }

  const { chassis_number, severity, resolved_status, limit } = req.query;

  try {
    const tool = telematicsTools.find(t => t.name === "get_fault_codes");
    if (!tool) throw new Error("Tool get_fault_codes not found");

    const resultText = await runTool(tool, {
      chassis_number: queryString(chassis_number),
      severity: queryString(severity),
      resolved_status: queryString(resolved_status),
      limit: queryInteger(limit),
    });
    return res.json(JSON.parse(resultText));
  } catch (error: unknown) {
    console.error("Error fetching faults via ADK:", error);
    res.status(500).json({ error: errorDetails(error).message });
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
  } catch (error: unknown) {
    console.error("Initialization error:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down gateway services...");
  if (salesToolset) await salesToolset.close();
  if (telematicsToolset) await telematicsToolset.close();
  process.exit(0);
});

main();
