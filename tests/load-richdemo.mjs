import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGE-ERR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });

await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));

await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent?.includes('richdemo.tex'));
  b?.click();
});

for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const info = await page.evaluate(() => {
    const cm = document.querySelector('.cm-content');
    return {
      cmLen: cm?.textContent?.length || 0,
      cmHead: cm?.textContent?.slice(0, 60),
      hasLoading: !!document.querySelector('.loading-spinner'),
      hasOverlay: !!document.querySelector('[aria-live="polite"]'),
    };
  });
  console.log(`t=${i+1}s : len=${info.cmLen} loading=${info.hasLoading} overlay=${info.hasOverlay} head="${info.cmHead}"`);
  if (info.cmLen > 100) break;
}
await browser.close();
