import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));

// Set seti theme.
await page.evaluate(() => {
  localStorage.setItem('weft-loom-icon-theme', 'seti');
  window.dispatchEvent(new CustomEvent('weft-loom-icon-theme-change', { detail: 'seti' }));
});
await new Promise(r => setTimeout(r, 1500));

const info = await page.evaluate(() => {
  // Check font-face loaded
  const fontFaceLoaded = Array.from(document.fonts).some(f => f.family === 'seti' && f.status === 'loaded');
  // Sample an icon span
  const span = document.querySelector('.seti-icon');
  const ch = span?.textContent;
  const code = ch ? ch.codePointAt(0)?.toString(16) : null;
  const cs = span ? getComputedStyle(span).fontFamily : null;
  return {
    fontFaceLoaded,
    fontsAvailable: Array.from(document.fonts).map(f => ({ family: f.family, status: f.status })),
    sampleChar: ch,
    sampleCode: code,
    sampleFontFamily: cs,
    setiSpanCount: document.querySelectorAll('.seti-icon').length,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
