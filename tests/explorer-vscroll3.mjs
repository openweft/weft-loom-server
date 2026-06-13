import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
// Look at ALL visible li in the file explorer + measure cumulative height.
const info = await page.evaluate(() => {
  const ul = document.querySelector('aside ul.menu, ul.menu.menu-sm');
  if (!ul) return null;
  const lis = Array.from(ul.querySelectorAll('li'));
  let total = 0;
  let hidden = 0;
  lis.forEach(li => {
    const rect = li.getBoundingClientRect();
    if (rect.height > 0) total += rect.height;
    else hidden++;
  });
  return {
    ulClientH: ul.clientHeight,
    ulScrollH: ul.scrollHeight,
    ulOffsetH: ul.offsetHeight,
    liCount: lis.length,
    sumHeights: total,
    hiddenLis: hidden,
    firstLiH: lis[0]?.getBoundingClientRect().height,
    lastLiH: lis[lis.length-1]?.getBoundingClientRect().height,
    overflow: getComputedStyle(ul).overflow,
    overflowY: getComputedStyle(ul).overflowY,
    display: getComputedStyle(ul).display,
    flexDirection: getComputedStyle(ul).flexDirection,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
