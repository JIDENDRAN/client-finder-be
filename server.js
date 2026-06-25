import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { db } from './services/db.js';
import { searchBusinesses } from './services/places.js';
import { initScheduler, runScheduledScan } from './services/scheduler.js';

dotenv.config();

// Prevent server crashes from unhandled async errors in dependencies like whatsapp-web.js/puppeteer
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Create Server
const server = createServer(app);

// Create WebSocket Server
const wss = new WebSocketServer({ server });

// List of connected websocket clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`WebSocket client connected. Total clients: ${clients.size}`);
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`WebSocket client disconnected. Total clients: ${clients.size}`);
  });
});

// Broadcast helper function
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}




// ==========================================
// API ROUTES
// ==========================================

// --- SETTINGS ---
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const settings = await db.updateSettings(req.body);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GOOGLE PLACES SCANNER ---
app.post('/api/places/search', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }
  try {
    const results = await searchBusinesses(query);
    if (results.length > 0) {
      // Automatically save to our permanent database
      await db.addScraped(results);
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SCRAPED LEADS HISTORY ---
app.get('/api/scraped', async (req, res) => {
  try {
    const scraped = await db.getScraped();
    res.json(scraped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LEADS ---
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await db.getLeads();
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const leadsToAdd = Array.isArray(req.body) ? req.body : [req.body];
    const addedLeads = await db.addLeads(leadsToAdd);
    // Broadcast updates
    for (const lead of addedLeads) {
      broadcast({ type: 'lead_added', lead });
    }
    res.status(201).json(addedLeads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', async (req, res) => {
  try {
    const updatedLead = await db.updateLead(req.params.id, req.body);
    if (!updatedLead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    broadcast({ type: 'lead_updated', lead: updatedLead });
    res.json(updatedLead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/scraped/:id', async (req, res) => {
  try {
    const updatedScraped = await db.updateScraped(req.params.id, req.body);
    if (!updatedScraped) {
      return res.status(404).json({ error: 'Scraped business not found' });
    }
    res.json(updatedScraped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    const success = await db.deleteLead(req.params.id);
    if (!success) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    broadcast({ type: 'lead_deleted', leadId: req.params.id });
    res.json({ message: 'Lead deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to manually trigger the daily scan for testing
app.post('/api/scheduler/trigger', async (req, res) => {
  try {
    const statusResult = await runScheduledScan();
    res.json(statusResult);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Start server
server.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Initialize daily scheduler
  initScheduler();
});
