import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
// Expand .weft-loom directory
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('.weft-loom'));
  btn?.click();
});
await new Promise(r => setTimeout(r, 1500));
const info = await page.evaluate(() => {
  const ul = document.querySelector('aside ul.menu, ul.menu.menu-sm');
  const aside = ul?.closest('aside');
  const parent = ul?.parentElement;
  return {
    ulClientH: ul?.clientHeight,
    ulScrollH: ul?.scrollHeight,
    asideH: aside?.clientHeight,
    parentH: parent?.clientHeight,
    parentOverflow: parent ? getComputedStyle(parent).overflow : null,
    ulOverflowY: ul ? getComputedStyle(ul).overflowY : null,
    childCount: ul?.children.length,
    canScroll: ul ? ul.scrollHeight > ul.clientHeight : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
