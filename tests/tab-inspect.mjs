import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
const info = await page.evaluate(() => {
  const tabBar = document.querySelector('[role="tablist"].flex.items-stretch');
  if (!tabBar) return 'no tab bar';
  return {
    classes: tabBar.className,
    rect: tabBar.getBoundingClientRect(),
    innerHTML: tabBar.outerHTML.slice(0, 800),
    children: Array.from(tabBar.children).map(c => ({
      tag: c.tagName,
      cls: c.className.slice(0, 100),
      h: c.getBoundingClientRect().height,
    })),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
