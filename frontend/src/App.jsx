import React, { useState, useEffect, useRef } from 'react';

// API Server Address matching our backend gateway port
const API_BASE = 'http://localhost:5001/api';

function App() {
  // Store the conversation messages history
  const [messages, setMessages] = useState([]);

  // Track current text in message input field
  const [inputValue, setInputValue] = useState('');

  // Flag indicating if a request is currently being resolved by the servers
  const [loading, setLoading] = useState(false);

  // Ref to automatically scroll chat window to bottom when new messages arrive
  const chatEndRef = useRef(null);

  /**
   * Helper function to scroll the chat timeline to the bottom.
   *
   * WHY: When a user receives a new message or tool execution block,
   * scrolling to the bottom ensures the new content is immediately visible
   * without requiring manual scrolling.
   */
  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Scroll to bottom every time messages list updates
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  /**
   * Initializes the chat on page load with a greeting from the AI.
   *
   * WHY: Welcomes the user and educates them on what data queries are
   * supported by the two connected MCP servers, giving them immediate
   * suggestions to click and test.
   */
  useEffect(() => {
    setMessages([
      {
        sender: 'assistant',
        text: "Hello! I am your FleetMind MCP Assistant. I am connected to two Model Context Protocol servers:\n\n1. **vehicle-sales-server** (exposing vehicle sales contract metrics)\n2. **vehicle-telematics-server** (exposing live speed, SoC, temps, and fault codes)\n\nYou can query databases using natural phrases or select a quick query below."
      }
    ]);
  }, []);

  /**
   * Formats raw pricing values into localized Indian Rupees (INR).
   *
   * WHY: Since prices in our MongoDB collections are stored as raw integers,
   * presenting them as formatted currency strings is essential for clean UI layouts.
   */
  const formatINR = (value) => {
    if (value === undefined || value === null) return 'N/A';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0
    }).format(value);
  };

  /**
   * Formats a raw javascript object or array into a pretty-printed JSON string.
   *
   * WHY: Used to display raw payloads in mock "tool call logs" to let the
   * user inspect exactly what arguments were passed to the MCP servers.
   */
  const formatArgs = (args) => {
    return JSON.stringify(args, null, 2);
  };

  /**
   * Core routing function: parses user text queries and queries backend REST endpoints.
   *
   * WHY: Inspects text queries using regex/keyword matching to identify
   * target variables (like Chassis Numbers, Zones, or Model Classes) and maps
   * them to the corresponding API calls on the Express/MCP gateway.
   */
  const handleQueryProcess = async (text) => {
    setLoading(true);

    // Add user query to conversation history immediately
    const userMsg = { sender: 'user', text };
    const updatedHistory = [...messages, userMsg];
    setMessages(updatedHistory);

    try {
      // POST the query to our Gemini /api/chat gateway endpoint
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: text,
          history: messages // pass existing history (excluding the new user query we just appended)
        })
      });

      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }

      const responseData = await res.json();

      if (responseData.error) {
        throw new Error(responseData.error);
      }

      // If the LLM agent called any tools, append them as visual logs/widgets in sequence
      if (responseData.toolCalls && responseData.toolCalls.length > 0) {
        for (const call of responseData.toolCalls) {
          // Identify widget type based on MCP tool name
          let widgetType = '';
          if (call.tool === 'get_vehicle_sales') {
            // Render detailed view if querying a specific chassis, otherwise general table
            widgetType = call.arguments.chassis_number ? 'sales' : 'sales-table';
          } else if (call.tool === 'get_sales_summary') {
            widgetType = 'sales-list';
          } else if (call.tool === 'get_telematics_data') {
            widgetType = 'telematics';
          } else if (call.tool === 'get_fault_codes') {
            // Render detailed fault log if querying a specific chassis, otherwise general table
            widgetType = call.arguments.chassis_number ? 'faults' : 'faults-table';
          }

          // Append tool execution block to timeline
          setMessages(prev => [...prev, {
            sender: 'assistant',
            toolCall: {
              server: call.server,
              tool: call.tool,
              arguments: call.arguments
            },
            widget: {
              type: widgetType,
              data: call.data,
              groupBy: call.arguments.group_by
            }
          }]);
        }
      }

      // Finally, append the assistant's conversational text response
      setMessages(prev => [...prev, {
        sender: 'assistant',
        text: responseData.text
      }]);

    } catch (err) {
      console.error('Error querying backend:', err);
      setMessages(prev => [...prev, {
        sender: 'assistant',
        text: `Error connecting to gateway: ${err.message}. Please verify if the Express backend gateway is active on port 5001.`
      }]);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handles user submission of a query.
   *
   * WHY: Prevents browser page refresh, extracts text from the input,
   * and fires the backend parsing request.
   */
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!inputValue.trim() || loading) return;
    const text = inputValue;
    setInputValue('');
    handleQueryProcess(text);
  };

  return (
    <div className="app-container">
      {/* Top Application Header */}
      <header>
        <div>
          <h1>
            <span>FleetMind EV Assistant</span>
            <span style={{ fontSize: '0.8rem', padding: '0.2rem 0.6rem', background: '#3b82f6', borderRadius: '4px', color: '#fff', verticalAlign: 'middle', marginLeft: '10px', fontWeight: 'bold' }}>
              MCP CHATWAY
            </span>
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            Ask questions to query MongoDB through vehicle-sales & vehicle-telematics servers
          </p>
        </div>
        <div className="system-status">
          <div>Sales MCP: <span className="status-badge"><span className="status-dot"></span>Active</span></div>
          <div>Telematics MCP: <span className="status-badge"><span className="status-dot"></span>Active</span></div>
        </div>
      </header>

      {/* Main chat timeline container */}
      <div className="chat-window">
        <div className="chat-timeline">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message-row ${msg.sender}`}>

              {/* Main text message bubble */}
              {msg.text && (
                <div className="message-bubble">
                  {msg.text.split('\n').map((line, lIdx) => (
                    <p key={lIdx} style={{ marginBottom: line ? '0.5rem' : '1rem' }}>
                      {/* Very simple markdown strong support */}
                      {line.split('**').map((part, pIdx) =>
                        pIdx % 2 === 1 ? <strong key={pIdx}>{part}</strong> : part
                      )}
                    </p>
                  ))}
                </div>
              )}

              {/* Stdio tool call block output wrapper */}
              {msg.toolCall && (
                <div className="tool-execution-block">
                  <div className="tool-header">★ Call MCP Tool</div>
                  <div><strong>Server:</strong> {msg.toolCall.server}</div>
                  <div><strong>Tool:</strong> {msg.toolCall.tool}</div>
                  <div><strong>Arguments:</strong></div>
                  <pre style={{ marginTop: '0.25rem', overflowX: 'auto' }}>
                    <code>{formatArgs(msg.toolCall.arguments)}</code>
                  </pre>
                </div>
              )}

              {/* Data Widgets (rendered inline within the message row) */}
              {msg.widget && (
                <div className="inline-widget">

                  {/* WIDGET 1: Vehicle Sales details profile */}
                  {msg.widget.type === 'sales' && msg.widget.data.length === 0 && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No sales record found in database.</div>
                  )}
                  {msg.widget.type === 'sales' && msg.widget.data.map((record) => (
                    <div key={record._id} className="details-grid">
                      <div className="detail-item">
                        <span className="detail-label">Model Name</span>
                        <span className="detail-value">{record.model_name}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Segment</span>
                        <span className="detail-value">{record.vertical_label || record.vertical}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Dealer Name</span>
                        <span className="detail-value">{record.dealer_name}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Sale Date</span>
                        <span className="detail-value">{record.sale_date}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Customer Name</span>
                        <span className="detail-value">{record.customer_name}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Customer Type</span>
                        <span className="detail-value">{record.customer_type}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Ex-Showroom Price</span>
                        <span className="detail-value">{formatINR(record.ex_showroom_price_inr)}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Battery Capacity</span>
                        <span className="detail-value">{record.battery_capacity_kwh} kWh</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Motor Power</span>
                        <span className="detail-value">{record.motor_power_kw} kW</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Warranty</span>
                        <span className="detail-value">{record.warranty_years} Years</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Salesperson</span>
                        <span className="detail-value">{record.salesperson_name}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Status</span>
                        <span className="detail-value">
                          <span className="badge resolved">{record.sale_status}</span>
                        </span>
                      </div>
                    </div>
                  ))}

                  {/* WIDGET 2: General sales table */}
                  {msg.widget.type === 'sales-table' && (
                    <table>
                      <thead>
                        <tr>
                          <th>Chassis</th>
                          <th>Model</th>
                          <th>Zone</th>
                          <th>Customer</th>
                          <th>Ex-Showroom Price</th>
                          <th>Sale Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {msg.widget.data.map((sale) => (
                          <tr key={sale._id}>
                            <td style={{ color: 'var(--color-primary)', fontWeight: 'bold' }}>{sale.chassis_number}</td>
                            <td>{sale.model_name}</td>
                            <td>{sale.zone}</td>
                            <td>{sale.customer_name}</td>
                            <td>{formatINR(sale.ex_showroom_price_inr)}</td>
                            <td>{sale.sale_date}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* WIDGET 3: Live Telematics Gauge metrics */}
                  {msg.widget.type === 'telematics' && msg.widget.data.length === 0 && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No telematics logs logged for this vehicle.</div>
                  )}
                  {msg.widget.type === 'telematics' && msg.widget.data.map((tele) => (
                    <div key={tele._id}>
                      <div className="telematics-dashboard">
                        <div className="metric-gauge">
                          <span className="gauge-value">{tele.soc_percent}%</span>
                          <span className="gauge-label">Battery Charge</span>
                        </div>
                        <div className="metric-gauge">
                          <span className="gauge-value">{tele.speed_kmph} km/h</span>
                          <span className="gauge-label">Current Speed</span>
                        </div>
                        <div className="metric-gauge">
                          <span className="gauge-value">{tele.range_remaining_km} km</span>
                          <span className="gauge-label">Remaining Range</span>
                        </div>
                        <div className="metric-gauge">
                          <span className="gauge-value">{tele.battery_temp_c}°C</span>
                          <span className="gauge-label">Battery Temp</span>
                        </div>
                        <div className="metric-gauge">
                          <span className="gauge-value">{tele.motor_temp_c}°C</span>
                          <span className="gauge-label">Motor Temp</span>
                        </div>
                        <div className="metric-gauge">
                          <span className="gauge-value">{tele.odometer_km} km</span>
                          <span className="gauge-label">Odometer</span>
                        </div>
                      </div>
                      <div style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        <div><strong>Location:</strong> Lat {tele.gps_latitude}, Lng {tele.gps_longitude}</div>
                        <div><strong>Status:</strong> {tele.vehicle_status} | <strong>Ignition:</strong> {tele.ignition_status} | <strong>Charging:</strong> {tele.charging_status}</div>
                        <div><strong>Alert Status:</strong> <span style={{ color: tele.alert_flag === 'Yes' ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 'bold' }}>{tele.alert_flag === 'Yes' ? 'Triggered Alert' : 'No Alert'}</span></div>
                      </div>
                    </div>
                  ))}

                  {/* WIDGET 4: Vehicle Fault logs details */}
                  {msg.widget.type === 'faults' && msg.widget.data.length === 0 && (
                    <div style={{ color: 'var(--color-success)', fontSize: '0.9rem', fontWeight: 'bold' }}>✓ No fault codes logged in system. Vehicle health is normal.</div>
                  )}
                  {msg.widget.type === 'faults' && (
                    <table>
                      <thead>
                        <tr>
                          <th>Fault Code</th>
                          <th>Component</th>
                          <th>Severity</th>
                          <th>Downtime</th>
                          <th>Repair Cost</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {msg.widget.data.map((fault) => (
                          <tr key={fault._id}>
                            <td style={{ color: 'var(--color-danger)', fontWeight: 'bold' }}>{fault.fault_code}</td>
                            <td>{fault.component}</td>
                            <td>
                              <span className={`badge ${
                                fault.severity === 'Critical' ? 'critical' :
                                fault.severity === 'Major' ? 'major' : 'minor'
                              }`}>
                                {fault.severity}
                              </span>
                            </td>
                            <td>{fault.downtime_hours} hrs</td>
                            <td>{formatINR(fault.cost_of_repair_inr)}</td>
                            <td>
                              <span className={`badge ${fault.resolved_status === 'Resolved' ? 'resolved' : 'progress'}`}>
                                {fault.resolved_status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* WIDGET 5: General Faults table list */}
                  {msg.widget.type === 'faults-table' && (
                    <table>
                      <thead>
                        <tr>
                          <th>Chassis</th>
                          <th>Fault Code</th>
                          <th>Component</th>
                          <th>Severity</th>
                          <th>Reported At</th>
                          <th>Repair Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {msg.widget.data.map((fault) => (
                          <tr key={fault._id}>
                            <td style={{ color: 'var(--color-primary)', fontWeight: 'bold' }}>{fault.chassis_number}</td>
                            <td style={{ color: 'var(--color-danger)', fontWeight: 'bold' }}>{fault.fault_code}</td>
                            <td>{fault.component}</td>
                            <td>
                              <span className={`badge ${
                                fault.severity === 'Critical' ? 'critical' :
                                fault.severity === 'Major' ? 'major' : 'minor'
                              }`}>
                                {fault.severity}
                              </span>
                            </td>
                            <td>{fault.detected_timestamp}</td>
                            <td>{formatINR(fault.cost_of_repair_inr)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* WIDGET 6: Sales statistics summary list */}
                  {msg.widget.type === 'sales-list' && (
                    <table>
                      <thead>
                        <tr>
                          <th>{msg.widget.groupBy.replace('_', ' ').toUpperCase()}</th>
                          <th>Units Sold</th>
                          <th>Total Revenue</th>
                          <th>Avg Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {msg.widget.data.map((sum, sumIdx) => (
                          <tr key={sumIdx}>
                            <td style={{ fontWeight: 'bold' }}>{sum._id || 'General'}</td>
                            <td>{sum.total_sales} units</td>
                            <td>{formatINR(sum.total_revenue_inr)}</td>
                            <td>{formatINR(sum.avg_price_inr)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                </div>
              )}

            </div>
          ))}
          {/* Invisible ref to scroll to bottom */}
          <div ref={chatEndRef} />
        </div>

        {/* Loading status indicator */}
        {loading && (
          <div className="suggestions-panel" style={{ borderTop: 'none', padding: '0.5rem 1.5rem' }}>
            <div className="loading-indicator">
              <div className="spinner"></div>
              <span>Querying database via Model Context Protocol...</span>
            </div>
          </div>
        )}

        {/* Clickable Quick action suggestions panel */}
        <div className="suggestions-panel">
          <button
            className="suggestion-chip"
            onClick={() => handleQueryProcess("Show sales for SCV25000001")}
            disabled={loading}
          >
            Show Sales for SCV25000001
          </button>
          <button
            className="suggestion-chip"
            onClick={() => handleQueryProcess("Get telematics for SCV25000001")}
            disabled={loading}
          >
            Get Telematics for SCV25000001
          </button>
          <button
            className="suggestion-chip"
            onClick={() => handleQueryProcess("Check faults for SCV25000001")}
            disabled={loading}
          >
            Check Faults for SCV25000001
          </button>
          <button
            className="suggestion-chip"
            onClick={() => handleQueryProcess("Summarize sales by model")}
            disabled={loading}
          >
            Summarize Sales by Model
          </button>
          <button
            className="suggestion-chip"
            onClick={() => handleQueryProcess("List recent sales in West region")}
            disabled={loading}
          >
            List West Sales
          </button>
          <button
            className="suggestion-chip"
            onClick={() => handleQueryProcess("Find critical faults")}
            disabled={loading}
          >
            Find Critical Faults
          </button>
        </div>

        {/* Input Bar Form */}
        <form onSubmit={handleSubmit} className="input-area">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Ask about vehicle sales, telemetry variables, or diagnostic faults..."
            disabled={loading}
          />
          <button type="submit" className="btn-send" disabled={loading || !inputValue.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;
