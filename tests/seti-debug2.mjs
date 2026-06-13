import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
await page.evaluate(() => {
  localStorage.setItem('weft-loom-icon-theme', 'seti');
  window.dispatchEvent(new CustomEvent('weft-loom-icon-theme-change', { detail: 'seti' }));
});
await new Promise(r => setTimeout(r, 1500));
const info = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('.seti-icon'));
  return spans.slice(0, 8).map(s => {
    const ch = s.textContent || '';
    return {
      char: ch,
      code: ch.length > 0 ? ch.codePointAt(0)?.toString(16) : null,
      parentText: (s.parentElement?.textContent || '').trim().slice(0, 30),
    };
  });
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
