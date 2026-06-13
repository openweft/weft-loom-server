import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
const info = await page.evaluate(() => {
  const ul = document.querySelector('aside ul.menu, ul.menu.menu-sm');
  if (!ul) return { found: false };
  const rect = ul.getBoundingClientRect();
  const items = Array.from(ul.children).map((li, idx) => {
    const inner = li.firstElementChild;
    return {
      idx,
      liW: li.getBoundingClientRect().width,
      liScroll: li.scrollWidth,
      innerW: inner?.getBoundingClientRect().width,
      innerScroll: inner?.scrollWidth,
      text: (li.textContent || '').trim().slice(0, 50),
    };
  });
  return { ulW: rect.width, ulScroll: ul.scrollWidth, items: items.slice(0, 8) };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
