import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGE-ERR:', e.message));

await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));

// Click the + button in the file explorer to open NewFileDialog
const opened = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.title?.includes('Create') || b.getAttribute('aria-label')?.toLowerCase().includes('new') || b.textContent?.trim() === '+');
  if (btn) { btn.click(); return true; }
  return false;
});
console.log('opened newfile?', opened);
await new Promise(r => setTimeout(r, 1000));

// Count language options visible
const before = await page.evaluate(() => {
  const sels = document.querySelectorAll('dialog.modal-open select');
  return Array.from(sels).map(s => Array.from(s.options).map(o => o.text));
});
console.log('before filter:', JSON.stringify(before, null, 2));

// Type "hcl" in the first filter input
await page.evaluate(() => {
  const inp = document.querySelector('dialog.modal-open input[placeholder*="Filter languages"]');
  if (inp) {
    inp.value = 'hcl';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await new Promise(r => setTimeout(r, 500));

const after = await page.evaluate(() => {
  const sels = document.querySelectorAll('dialog.modal-open select');
  return Array.from(sels).map(s => ({
    value: s.value,
    options: Array.from(s.options).map(o => o.text),
  }));
});
console.log('after filter "hcl":', JSON.stringify(after, null, 2));
await browser.close();
