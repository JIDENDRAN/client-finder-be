import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'database.json');

// Default Database Structure
const DEFAULT_DB = {
  leads: [],
  scraped: [],
  settings: {
    googleApiKey: '',
    geminiApiKey: '',
    businessName: 'My Business',
    businessDesc: 'We offer professional web development, SEO services, and digital marketing to help local businesses grow.',
    promptTemplate: `You are an AI sales assistant for "{{businessName}}". Here is our business details:\n{{businessDesc}}\n\nYour goal is to answer any questions the client has about our services, be polite, professional, and try to book a quick call or meeting. Keep your answers brief (1-3 sentences) and suitable for WhatsApp. Never make things up. If you cannot answer, say that you will have a human representative contact them shortly.`,
    defaultMsgTemplate: 'Hi {{name}}, I noticed your business "{{name}}" on Google Maps in {{address}}. We specialize in helping local businesses get more clients. Would you be open to a quick chat about how we can help you grow?',
    cooldownMin: 10, // seconds
    cooldownMax: 20  // seconds
  }
};

let dbCache = null;
let writeQueue = Promise.resolve();

// Load DB from file
async function loadDb() {
  if (dbCache) return dbCache;
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    dbCache = JSON.parse(data);
    
    // Ensure all default sections exist
    dbCache.leads = dbCache.leads || [];
    dbCache.scraped = dbCache.scraped || [];
    dbCache.settings = { ...DEFAULT_DB.settings, ...dbCache.settings };
    
    return dbCache;
  } catch (err) {
    // File doesn't exist, create it with defaults
    dbCache = JSON.parse(JSON.stringify(DEFAULT_DB));
    await saveDb();
    return dbCache;
  }
}

// Save DB to file (queued atomic write to prevent corruption)
async function saveDb() {
  if (!dbCache) return;
  
  writeQueue = writeQueue.then(async () => {
    try {
      const tempPath = `${DB_FILE}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(dbCache, null, 2), 'utf8');
      await fs.rename(tempPath, DB_FILE);
    } catch (err) {
      console.error('Failed to write database file:', err);
    }
  });
  
  return writeQueue;
}

export const db = {
  // --- SETTINGS ---
  getSettings: async () => {
    const data = await loadDb();
    return data.settings;
  },
  
  updateSettings: async (newSettings) => {
    const data = await loadDb();
    data.settings = { ...data.settings, ...newSettings };
    await saveDb();
    return data.settings;
  },

  // --- SCRAPED LEADS HISTORY ---
  getScraped: async () => {
    const data = await loadDb();
    return data.scraped || [];
  },

  addScraped: async (newScrapedItems) => {
    const data = await loadDb();
    if (!data.scraped) data.scraped = [];
    
    const added = [];
    for (const item of newScrapedItems) {
      // Avoid exact duplicates by matching name and phone
      const isDuplicate = data.scraped.some(s => s.name === item.name && s.phone === item.phone);
      if (!isDuplicate) {
        data.scraped.push({
          ...item,
          spokenToClient: false,
          scrapedAt: new Date().toISOString()
        });
        added.push(item);
      }
    }
    
    if (added.length > 0) {
      await saveDb();
    }
    return data.scraped;
  },

  // --- LEADS ---
  getLeads: async () => {
    const data = await loadDb();
    return data.leads;
  },
  
  getLead: async (id) => {
    const data = await loadDb();
    return data.leads.find(l => l.id === id);
  },

  addLeads: async (newLeads) => {
    const data = await loadDb();
    const added = [];
    for (const lead of newLeads) {
      // Avoid duplicate place ID
      if (!data.leads.some(l => l.id === lead.id)) {
        const fullLead = {
          id: lead.id || `lead_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          status: 'scanned',
          interest: 'none',
          notes: '',
          lastContacted: null,
          autoPilot: true,
          createdAt: new Date().toISOString(),
          ...lead
        };
        data.leads.push(fullLead);
        added.push(fullLead);
      }
    }
    if (added.length > 0) {
      await saveDb();
    }
    return added;
  },

  updateLead: async (id, updates) => {
    const data = await loadDb();
    const index = data.leads.findIndex(l => l.id === id);
    if (index !== -1) {
      data.leads[index] = { ...data.leads[index], ...updates };
      await saveDb();
      return data.leads[index];
    }
    return null;
  },

  updateScraped: async (id, updates) => {
    const data = await loadDb();
    const index = data.scraped.findIndex(s => s.id === id);
    if (index !== -1) {
      data.scraped[index] = { ...data.scraped[index], ...updates };
      await saveDb();
      return data.scraped[index];
    }
    return null;
  },

  deleteLead: async (id) => {
    const data = await loadDb();
    const len = data.leads.length;
    data.leads = data.leads.filter(l => l.id !== id);
    if (data.leads.length !== len) {
      await saveDb();
      return true;
    }
    return false;
  }
};

