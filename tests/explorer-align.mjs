import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
const info = await page.evaluate(() => {
  const aside = document.querySelector('aside.bg-base-100.border-r, aside.bg-base-100');
  const ul = aside?.querySelector('ul');
  const lis = Array.from(ul?.querySelectorAll('li') || []).slice(0, 3);
  return lis.map(li => {
    const btn = li.querySelector('button');
    const rect = btn?.getBoundingClientRect();
    const cs = btn ? getComputedStyle(btn) : null;
    return {
      text: (li.textContent || '').trim().slice(0, 30),
      btnRect: rect ? { x: rect.x, w: rect.width, left: rect.left } : null,
      btnPadL: cs?.paddingLeft,
      textAlign: cs?.textAlign,
      justifyContent: cs?.justifyContent,
    };
  });
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
