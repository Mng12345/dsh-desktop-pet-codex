// Execute with `playwriter -s <your-session> -f tools/browser-results-regression.js`.
// This renders built UI assets against isolated fixture data; it does not access DSH sessions.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve('pet-app/dist');
const phases = ['completed', 'stopped', 'waiting', 'running'];
const titles = ['本轮修改已完成', '手动停止的任务', '等你拍板的审批', '正在跑的一轮'];
const results = ['completed', 'stopped'];
const fixture = {
  version: 1, revision: 1, at: 1,
  settings: { scale: 1, fontScale: 1, visible: true, opacity: 1, showSessionList: true, alwaysOnTop: true },
  totals: { sessions: 4, running: 1, waiting: 1, subagents: 0 },
  watch: phases,
  groups: [{ id: 'preview', title: '结果状态 · 测试数据', updatedAt: 1,
    nodes: phases.map((phase, i) => ({ children: [], session: {
      id: phase, title: titles[i], label: 'preview', phase, running: phase === 'running',
      isSubagent: false, subagentCount: 0, lastTool: 'stale-tool', thought: null,
      thoughtKind: null, updatedAt: 1, error: phase === 'stopped' ? '服务返回错误' : null,
      // The removal control is the Host's verdict, carried on the row.
      dismissible: results.includes(phase),
    } })) }],
};
state.visualPage = await context.newPage();
await state.visualPage.setViewportSize({ width: 410, height: 375 });
await state.visualPage.route('http://pet-results.test/**', async (route) => {
  const name = path.basename(new URL(route.request().url()).pathname);
  if (['watch', 'focus', 'review', 'settings'].includes(name)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }
  const file = path.join(root, name || 'roster.html');
  if (!['.html', '.js', '.css'].includes(path.extname(file))) return route.abort();
  const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
  await route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file, 'utf8') });
});
await state.visualPage.addInitScript((snap) => {
  window.__TAURI__ = { core: { invoke: async (command) => command === 'pet_endpoint'
    ? { url: 'http://pet-results.test', token: null } : undefined } };
  window.EventSource = class extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor() {
      super();
      window.__fixtureSource = this;
      queueMicrotask(() => {
        this.dispatchEvent(new Event('open'));
        this.dispatchEvent(new MessageEvent('hello', { data: JSON.stringify(snap) }));
      });
    }
    close() { this.readyState = 2; }
  };
}, fixture);
await state.visualPage.goto('http://pet-results.test/roster.html', { waitUntil: 'domcontentloaded' });
await state.visualPage.getByText('本轮修改已完成', { exact: true }).waitFor({ state: 'visible' });
// A waiting session replaces the result segments with its own sentence.
if (!(await state.visualPage.getByText('1 个会话在等你', { exact: true }).count())) throw new Error('Missing waiting headline');
if (await state.visualPage.locator('#headline .headline-seg').count()) throw new Error('Waiting headline kept result segments');
for (const label of ['已完成', '已停止', '等你']) {
  if (!(await state.visualPage.getByText(label, { exact: true }).count())) throw new Error('Missing phase label: ' + label);
}
// A live row is the only one that names its tool, so "运行中" never renders here.
if (!(await state.visualPage.locator('#sessions li[data-phase="running"]').filter({ hasText: 'stale-tool' }).count())) throw new Error('Running row lost its tool name');
// A settled row names its result; only a live row may show a tool name.
const settled = state.visualPage.locator(
  results.map((phase) => `#sessions li[data-phase="${phase}"]`).join(', '),
);
if (await settled.filter({ hasText: 'stale-tool' }).count()) throw new Error('Stale tool masked terminal outcome');
if ((await state.visualPage.locator('[data-review]').count()) !== results.length) throw new Error('Result dismissal buttons missing');
const bounds = await state.visualPage.locator('#card').boundingBox();
if (!bounds || bounds.width > 410) throw new Error('Roster overflow');
await state.visualPage.locator('[data-review]').first().click();
if (!(await state.visualPage.getByText('本轮修改已完成', { exact: true }).count())) throw new Error('Request optimistically removed a row');
await state.visualPage.screenshot({ path: path.resolve('.ref/results-preview.png'), fullPage: true });
console.log('PASS built roster browser rendering: waiting headline, settled labels, live tool name on the running row, stale tool suppression on settled rows, two dismissal buttons, no optimistic deletion, width fits.');
console.log(await getLatestLogs({ page: state.visualPage, search: /error/i, sinceLastCall: true }));
