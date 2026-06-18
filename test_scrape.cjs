const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://www.google.com/maps/search/plumbers+in+coimbatore');
  await page.waitForSelector('.hfpxzc', { timeout: 10000 }).catch(()=>{});
  
  await new Promise(r => setTimeout(r, 2000));
  
  const data = await page.evaluate(() => {
    const el = document.querySelectorAll('.hfpxzc')[0];
    const mainCard = el.closest('.Nv2PK');
    return mainCard ? mainCard.innerHTML : 'NO CARD';
  });
  
  console.log(data);
  await browser.close();
})();
