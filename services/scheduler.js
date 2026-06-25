import cron from 'node-cron';
import { db } from './db.js';
import { scrapeGoogleMaps } from './places.js';

// Curated list of search suggestions in Coimbatore
const SUGGESTED_QUERIES = [
  "Restaurants in Coimbatore",
  "Plumbers in Coimbatore",
  "Dentists in Coimbatore",
  "Gyms in Coimbatore",
  "Real Estate Agents in Coimbatore",
  "Web Designers in Coimbatore",
  "Hospitals in Coimbatore",
  "Electricians in Coimbatore",
  "Spas in Coimbatore",
  "Lawyers in Coimbatore",
  "Caterers in Coimbatore",
  "Event Planners in Coimbatore",
  "Photographers in Coimbatore",
  "Digital Marketing Agencies in Coimbatore",
  "Interior Designers in Coimbatore",
  "Architects in Coimbatore",
  "Boutiques in Coimbatore",
  "Sarees shops in Coimbatore",
  "Travel Agencies in Coimbatore",
  "Hotels in Coimbatore",
  "Automobile Repair in Coimbatore",
  "Bike Service Centers in Coimbatore",
  "IT Companies in Coimbatore",
  "Colleges in Coimbatore",
  "Schools in Coimbatore",
  "Textile Mills in Coimbatore",
  "Hardware Stores in Coimbatore",
  "Furniture Shops in Coimbatore",
  "Jewellery Shops in Coimbatore",
  "Bakeries in Coimbatore",
  "Coffee Shops in Coimbatore",
  "Pest Control in Coimbatore",
  "Cleaning Services in Coimbatore",
  "Security Services in Coimbatore",
  "Advertising Agencies in Coimbatore",
  "Software Companies in Coimbatore",
  "Logistics in Coimbatore",
  "Packers and Movers in Coimbatore",
  "Yoga Classes in Coimbatore",
  "Fitness Centers in Coimbatore"
];

// Helper to fetch the number of leads scraped today
export async function getScrapedCountToday() {
  try {
    const scraped = await db.getScraped();
    const todayStr = new Date().toISOString().split('T')[0];
    const scrapedToday = scraped.filter(s => s.scrapedAt && s.scrapedAt.startsWith(todayStr));
    return scrapedToday.length;
  } catch (err) {
    console.error('Error fetching today\'s scraped count:', err);
    return 0;
  }
}

// Core execution method
export async function runScheduledScan() {
  console.log(`[Scheduler] Daily scan started at ${new Date().toLocaleString()}`);
  try {
    const countToday = await getScrapedCountToday();
    const targetDailyLimit = 50;

    if (countToday >= targetDailyLimit) {
      console.log(`[Scheduler] Already reached daily limit of ${targetDailyLimit} (Today's count: ${countToday}). Skipping scan.`);
      return { status: 'skipped', message: 'Daily limit already reached', countToday };
    }

    const remainingLimit = targetDailyLimit - countToday;
    console.log(`[Scheduler] Today's scraped count is ${countToday}. Target remaining to scrape: ${remainingLimit}`);

    // Select a random query from SUGGESTED_QUERIES
    const query = SUGGESTED_QUERIES[Math.floor(Math.random() * SUGGESTED_QUERIES.length)];
    console.log(`[Scheduler] Selected search query: "${query}"`);

    const results = await scrapeGoogleMaps(query, remainingLimit);
    if (results.length > 0) {
      await db.addScraped(results);
      console.log(`[Scheduler] Successfully scraped and saved ${results.length} clients.`);
    } else {
      console.log(`[Scheduler] No new clients found in this scan.`);
    }

    const finalCountToday = await getScrapedCountToday();
    return {
      status: 'completed',
      query,
      scrapedInThisRun: results.length,
      finalCountToday
    };

  } catch (err) {
    console.error('[Scheduler] Error during scheduled scan:', err);
    return { status: 'failed', error: err.message };
  }
}

// Register and export the cron job
export function initScheduler() {
  // cron expression: 0 12 * * * represents 12:00 PM daily
  cron.schedule('0 12 * * *', async () => {
    console.log('[Scheduler] Triggering 12 PM scheduled daily scan...');
    await runScheduledScan();
  });
  console.log('[Scheduler] Daily automated scanner initialized for 12:00 PM daily.');
}
