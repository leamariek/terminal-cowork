// Spike: load a page in Chrome, then paint it as Sixel at the top of this pane.
import { launchChrome } from '../../src/chrome.js';
import { toSixel } from '../../src/sixel.js';
const [url, w, h] = [process.argv[2], +process.argv[3], +process.argv[4]];
const c = await launchChrome({ profile: process.argv[5], width: w, height: h });
const loaded = new Promise((r) => c.on('Page.loadEventFired', r));
await c.send('Page.navigate', { url });
await loaded;
const shot = await c.send('Page.captureScreenshot', { format: 'png' });
const t0 = Date.now();
const six = await toSixel(Buffer.from(shot.data, 'base64'), w, h);
const enc = Date.now() - t0;
process.stdout.write('\x1b[2J\x1b[H' + six);
process.stderr.write(`\nencode ${enc} ms, ${six.length} bytes\n`);
c.close();
setTimeout(() => {}, 60000);
