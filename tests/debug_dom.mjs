import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
page.on('console', (msg) => console.log('[browser]', msg.type(), msg.text()));
page.on('pageerror', (e) => console.error('[error]', e.message, '\nstack:', e.stack?.split('\n').slice(0, 10).join('\n')));
await page.goto('http://127.0.0.1:8080', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 2000));

const info = await page.evaluate(() => {
  return {
    asides: document.querySelectorAll('aside').length,
    buttons: Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim().slice(0, 50)).slice(0, 30),
    fileExplorerHtml: document.querySelector('aside')?.outerHTML?.slice(0, 2000),
  };
});
console.log('asides=', info.asides);
console.log('buttons (first 30):');
info.buttons.forEach((b, i) => console.log(` [${i}] ${b}`));
console.log('\nfirst aside HTML (excerpt):');
console.log(info.fileExplorerHtml);
await browser.close();
