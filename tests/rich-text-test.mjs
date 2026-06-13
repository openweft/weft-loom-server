import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGE-ERR:', e.message));

await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent?.includes('richdemo.tex'));
  b?.click();
});
await new Promise(r => setTimeout(r, 6000));

const info = await page.evaluate(() => {
  const cm = document.querySelector('.cm-content');
  return {
    cmLen: cm?.textContent?.length || 0,
    cmHead: cm?.textContent?.slice(0, 100),
    headings: document.querySelectorAll('.cm-rich-h1, .cm-rich-h2, .cm-rich-h3, .cm-rich-h4, .cm-rich-h0').length,
    bolds: document.querySelectorAll('.cm-rich-bold').length,
    italics: document.querySelectorAll('.cm-rich-italic').length,
    math: document.querySelectorAll('.cm-rich-math, .cm-rich-math-display').length,
    shadows: document.querySelectorAll('.cm-rich-shadow').length,
    comments: document.querySelectorAll('.cm-rich-comment').length,
    bullets: document.querySelectorAll('.cm-rich-bullet').length,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
