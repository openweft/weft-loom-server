import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
const info = await page.evaluate(() => {
  const aside = document.querySelector('aside.bg-base-100.border-r, aside.h-full.w-full');
  const ul = aside?.querySelector('ul');
  if (!ul) return { found: false };
  const lis = Array.from(ul.querySelectorAll('li'));
  const buttons = lis.map(li => li.querySelector('button')).filter(Boolean);
  return {
    asideW: aside.clientWidth,
    ulW: ul.clientWidth,
    ulPadding: getComputedStyle(ul).padding,
    firstButton: buttons[0] ? {
      h: buttons[0].getBoundingClientRect().height,
      w: buttons[0].getBoundingClientRect().width,
      cls: buttons[0].className.slice(0, 80),
    } : null,
    sampleTexts: lis.slice(0, 5).map(li => (li.textContent || '').trim().slice(0, 30)),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
