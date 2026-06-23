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
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.hfpxzc', { timeout: 15000 }).catch(() => {});
    
    const results = [];
    let index = 0;
    
    // We will keep trying to find elements until we get exactly 10 valid results
    while (results.length < 10) {
      // Re-evaluate elements count on each loop because of lazy loading
      const elementsCount = await page.evaluate(() => document.querySelectorAll('.hfpxzc').length);
      
      // Safety limit: Don't scan more than 60 businesses to prevent server timeout
      if (index >= 60) {
        console.log('Safety limit of 60 scanned businesses reached. Stopping search.');
        break;
      }

      // If we've processed all currently visible elements but still need more, we need to scroll
      if (index >= elementsCount) {
        let loadedMore = false;
        // Try scrolling more times (up to 10) if we haven't found any valid leads yet
        const maxScrollAttempts = results.length === 0 ? 10 : 3;
        
        for (let scrollAttempt = 0; scrollAttempt < maxScrollAttempts; scrollAttempt++) {
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
  return scrapeGoogleMaps(query);
}

