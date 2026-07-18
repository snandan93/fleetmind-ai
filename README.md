# FleetMind AI

FleetMind AI is a conversational dashboard for exploring electric-vehicle sales,
telematics, and fault data stored in MongoDB. A React frontend sends natural-language
questions to an Express gateway, which uses Gemini to select and call two Model
Context Protocol (MCP) servers.

## Architecture

```text
React frontend (port 5173)
        |
Express + Gemini gateway (port 5001)
        |
        +-- vehicle-sales MCP server ------ MongoDB vehicle_sales
        +-- vehicle-telematics MCP server - MongoDB telematics_data / fault_codes
```

## Prerequisites

- Node.js 20.12 or newer
- npm
- A running MongoDB instance containing the required collections
- A Google Gemini API key

## Setup

1. Clone the repository and enter it:

   ```bash
   git clone https://github.com/snandan93/fleetmind-ai.git
   cd fleetmind-ai
   ```

2. Create the MCP environment files:

   ```bash
   cp mcp-servers/vehicle-sales/.env.example mcp-servers/vehicle-sales/.env
   cp mcp-servers/vehicle-telematics/.env.example mcp-servers/vehicle-telematics/.env
   ```

3. Update both `.env` files with your MongoDB connection details. The sales server
   supports these variables:

   ```dotenv
   MONGO_URI=mongodb://username:password@localhost:27017
   MONGO_DB_NAME=ev_sales_db
   SALES_COLLECTION=vehicle_sales
   ```

   The telematics server supports:

   ```dotenv
   MONGO_URI=mongodb://username:password@localhost:27017
   MONGO_DB_NAME=ev_sales_db
   TELEMATICS_COLLECTION=telematics_data
   FAULTS_COLLECTION=fault_codes
   ```

4. Create `backend/.env` and add your Gemini API key:

   ```dotenv
   GEMINI_API_KEY=your_gemini_api_key
   ```

   Do not commit any `.env` file or API key.

5. Install all workspace dependencies and build both MCP servers:

   ```bash
   npm run install-all
   ```

## Run locally

Start the MCP servers, Express gateway, and Vite frontend with:

```bash
npm run dev
```

Open `http://localhost:5173`. The API gateway runs at
`http://localhost:5001`.

Example questions:

- `Show sales for chassis number ABC123`
- `Show the latest telematics data for ABC123`
- `Which vehicle has the most critical alerts?`
- `What are the most common fault codes?`

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build the MCP servers and start the TypeScript backend and frontend in watch mode |
| `npm run check` | Type-check the backend, frontend, and both MCP servers |
| `npm run build` | Create production builds for every workspace |
| `npm run build:mcps` | Compile both TypeScript MCP servers |
| `npm run check:mcps` | Type-check both MCP servers without emitting files |
| `npm run dev --prefix backend` | Start only the TypeScript Express gateway in watch mode |
| `npm run build --prefix backend` | Compile the Express gateway to `backend/dist` |
| `npm run start --prefix backend` | Start the compiled Express gateway |
| `npm run dev --prefix frontend` | Start only the Vite frontend |
| `npm run build --prefix frontend` | Type-check and create a production frontend build |
| `npm run lint --prefix frontend` | Lint the frontend source |

## API endpoints

The Express gateway exposes:

- `POST /api/chat` — conversational Gemini and MCP tool-calling endpoint
- `GET /api/sales` — vehicle sales records
- `GET /api/sales/summary` — aggregated sales results
- `GET /api/telematics` — recent vehicle telemetry
- `GET /api/faults` — recent fault and maintenance records

The MCP servers communicate with the gateway over standard input/output and should
normally be launched through the root development command.
