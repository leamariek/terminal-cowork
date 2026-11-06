// Does a real internet navigation complete over the pipe? Uses its own Chrome and profile.
import { launchChrome, openTab } from '../../src/chrome.js';
const c = await launchChrome({ profile: process.argv[2] });
const seen = []; let t0 = Date.now();
c.onEvent((m, p) => { if (/^(Page\.(loadEventFired|frameNavigated|frameStartedLoading|frameStoppedLoading|javascriptDialogOpening|downloadWillBegin)|Inspector|Target\.(targetCrashed|detachedFromTarget))/.test(m)) seen.push(`${Date.now() - t0}ms ${m} ${p?.frame?.url?.slice(0, 60) ?? ''}`); });
const t = await openTab(c, { width: 990, height: 1080 });
const u = await openTab(c, { width: 990, height: 1080 });
await t.send('Page.bringToFront');
await t.send('Page.startScreencast', { format: 'png', maxWidth: 990, maxHeight: 1080, everyNthFrame: 1 });
c.onEvent((m, p, s) => { if (m === 'Page.screencastFrame') c.send('Page.screencastFrameAck', { sessionId: p.sessionId }, s).catch(() => {}); });
t0 = Date.now();
const r = await Promise.race([t.send('Page.navigate', { url: process.argv[3] }), new Promise((x) => setTimeout(() => x('NAVIGATE-NEVER-RETURNED'), 12000))]);
console.log('navigate returned after', Date.now() - t0, 'ms:', JSON.stringify(r).slice(0, 120));
await new Promise((x) => setTimeout(x, 3000));
console.log(seen.join('\n') || 'no page events at all');
c.close(); process.exit(0);
