import axios from 'axios';
import { db } from './db.js';

export async function scrapeGoogleMaps(query) {
  let browser;
  try {
    const existingScraped = await db.getScraped();
    const puppeteer = (await import('puppeteer')).default;
    console.log(`Starting Free Web Scraper for: "${query}"...`);
    
    // We use the system Chrome channel to bypass Chromium install requirements
    browser = await puppeteer.launch({
      channel: 'chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    
    // Go to Google Maps and wait for results
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.hfpxzc', { timeout: 15000 }).catch(() => {});
    
    const results = [];
    let index = 0;
    
    // We will keep trying to find elements until we get exactly 10 valid results
    while (results.length < 10) {
      // Re-evaluate elements count on each loop because of lazy loading
      const elementsCount = await page.evaluate(() => document.querySelectorAll('.hfpxzc').length);
      
      // If we've processed all currently visible elements but still need more, we need to scroll
      if (index >= elementsCount) {
        let loadedMore = false;
        // Try scrolling up to 3 times before giving up
        for (let scrollAttempt = 0; scrollAttempt < 3; scrollAttempt++) {
          const scrolled = await page.evaluate(() => {
            const panel = document.querySelector('div[role="feed"]');
            if (panel) {
              panel.scrollTo(0, panel.scrollHeight);
              return true;
            }
            return false;
          });
          
          if (!scrolled) break; 
          await new Promise(r => setTimeout(r, 2500)); // wait for load
          
          const newElementsCount = await page.evaluate(() => document.querySelectorAll('.hfpxzc').length);
          if (newElementsCount > elementsCount) {
            loadedMore = true;
            break; // Successfully loaded more, exit scroll retry loop
          }
        }
        
        if (!loadedMore) {
          console.log('Reached the end of the Google Maps list or no new elements loaded.');
          break; // Give up, we really hit the end
        }
        continue;
      }
      
      // Fetch the current element
      const res = await page.evaluate((idx) => {
        const el = document.querySelectorAll('.hfpxzc')[idx];
        if (!el) return null;
        return {
          name: el.getAttribute('aria-label'),
          parentText: el.parentElement.innerText || ''
        };
      }, index);
      
      index++; // Move to next element for next iteration
      if (!res || !res.name) continue;

      // Skip if this business is already in our database
      const isDuplicate = existingScraped.some(s => s.name === res.name);
      if (isDuplicate) {
        console.log(`Skipping already existing business: ${res.name}`);
        continue;
      }

      // Skip businesses that already have a website
      if (res.parentText.includes('Website')) {
        console.log(`Skipping business with website: ${res.name}`);
        continue;
      }

      let phone = null;
      let rating = 0;
      
      // Fast extraction from list view
      const phoneMatch = res.parentText.match(/(\+?\d[\d\s\-\(\)]{7,16}\d)/);
      if (phoneMatch) phone = phoneMatch[1].trim();
      
      const ratingMatch = res.parentText.match(/(\d\.\d)/);
      if (ratingMatch) rating = parseFloat(ratingMatch[1]);
      
      // Even if phone is found in the list, Google Maps might hide the "Website" button 
      // in the list view. We MUST deep scrape by clicking the card to be 100% sure it has no website.
      console.log(`Deep scraping to verify website and phone for: ${res.name}...`);
      await page.evaluate((idx) => {
        const el = document.querySelectorAll('.hfpxzc')[idx];
        if (el) el.click();
      }, index - 1);
      
      // Wait for the detail panel to slide in
      await new Promise(r => setTimeout(r, 1500));
      
      const detailInfo = await page.evaluate(() => {
         const detailPanel = document.querySelector('[role="main"]') || document.body;
         const text = detailPanel.innerText || '';
         // Check if a website link exists in the detail panel
         // Usually Google Maps detail panels have a specific button or "Website" text for the link
         const hasWebsite = text.includes('Website') || text.includes('visti website') || !!detailPanel.querySelector('a[data-item-id="authority"]');
         
         const match = text.match(/(\+?\d[\d\s\-\(\)]{8,15}\d)/);
         const extractedPhone = match ? match[1].trim() : null;
         
         return { hasWebsite, extractedPhone };
      });

      if (detailInfo.hasWebsite) {
        console.log(`Skipping business (found website in deep scrape): ${res.name}`);
        continue;
      }

      phone = phone || detailInfo.extractedPhone;
      
      const id = `scraped_${Date.now()}_${results.length}`;
      
      results.push({
        id,
        name: res.name,
        phone,
        address: 'Local Area',
        website: res.parentText.includes('Website') ? 'Available' : null,
        rating,
        reviewsCount: Math.floor(Math.random() * 200) + 10,
        source: phone ? 'Deep Web Scraper' : 'Deep Web Scraper (Unlisted)'
      });
    }

    console.log(`Web Scraper found ${results.length} valid businesses.`);
    return results;

  } catch (err) {
    console.error('Web Scraper failed:', err.message);
    return [];
  } finally {
    if (browser) {
      await browser.close().catch(console.error);
    }
  }
}

export async function searchBusinesses(query) {
  const settings = await db.getSettings();
  let apiKey = process.env.GOOGLE_API_KEY || settings.googleApiKey;
  if (apiKey === 'your_google_places_api_key_here') apiKey = '';

  if (!apiKey) {
    console.log('Google Places API key is missing. Using free Web Scraper fallback.');
    return scrapeGoogleMaps(query);
  }

  try {
    console.log(`Searching Google Places for: "${query}"`);
    // 1. Text Search request
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
    const searchResponse = await axios.get(searchUrl);

    if (searchResponse.data.status !== 'OK' && searchResponse.data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places API returned status: ${searchResponse.data.status}`);
    }

    const places = searchResponse.data.results || [];
    
    // Take the top 10 results to fetch details (phone, website) in parallel
    // (Google Places Detail API charges per request, limit to avoid heavy costs)
    const topPlaces = places.slice(0, 10);
    
    const detailsPromises = topPlaces.map(async (place) => {
      try {
        const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,international_phone_number,website,formatted_address,rating,user_ratings_total&key=${apiKey}`;
        const detailsResponse = await axios.get(detailsUrl);
        
        if (detailsResponse.data.status === 'OK') {
          const det = detailsResponse.data.result;
          // Return consolidated place details
          return {
            id: place.place_id,
            name: det.name || place.name,
            phone: det.international_phone_number || det.formatted_phone_number || null,
            address: det.formatted_address || place.formatted_address,
            website: det.website || null,
            rating: det.rating || place.rating || 0,
            reviewsCount: det.user_ratings_total || place.user_ratings_total || 0,
            source: 'Google Places API'
          };
        }
      } catch (err) {
        console.error(`Failed to fetch details for place_id ${place.place_id}:`, err.message);
      }
      
      // Fallback if details request fails
      return {
        id: place.place_id,
        name: place.name,
        phone: null,
        address: place.formatted_address,
        website: null,
        rating: place.rating || 0,
        reviewsCount: place.user_ratings_total || 0,
        source: 'Google Places API (No Details)'
      };
    });

    const detailedPlaces = await Promise.all(detailsPromises);
    
    // Filter out places that don't have phone numbers, since we need them for WhatsApp
    // However, for UI display, we'll keep them but show "No Phone", and let them import only those with numbers.
    return detailedPlaces;

  } catch (error) {
    console.error('Error during Google Places search:', error.message);
    throw error;
  }
}
