import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
const heights = await page.evaluate(() => {
  const hs = Array.from(document.querySelectorAll('header')).map(h => ({
    text: (h.textContent || '').trim().slice(0, 40),
    height: h.getBoundingClientRect().height,
    classes: h.className.slice(0, 80),
  }));
  // Also TabBar (it's a div role="tablist")
  const tabBar = document.querySelector('[role="tablist"].flex.items-stretch');
  if (tabBar) hs.push({ text: 'TabBar', height: tabBar.getBoundingClientRect().height, classes: 'tablist' });
  return hs;
});
heights.forEach(h => console.log(h.height.toFixed(1).padStart(6) + 'px  ' + h.text));
await browser.close();
