import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
const info = await page.evaluate(() => {
  const ul = document.querySelector('aside ul.menu, ul.menu.menu-sm');
  if (!ul) return { found: false };
  const cs = getComputedStyle(ul);
  return {
    width: ul.clientWidth,
    scrollW: ul.scrollWidth,
    minW: cs.minWidth,
    maxW: cs.maxWidth,
    display: cs.display,
    flexDir: cs.flexDirection,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
