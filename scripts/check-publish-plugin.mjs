// No Obsidian, child processes, network, or GUI needed: exercise the real plugin
// with event-driven process/DOM mocks and a deterministic local polling clock.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { StringDecoder } from 'node:string_decoder';

const pluginRoot = new URL('../integrations/obsidian/folio-publish/', import.meta.url);
const source = fs.readFileSync(new URL('main.js', pluginRoot), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', pluginRoot), 'utf8'));
const ROOT = '/workspace/folio project';
const STATUS_FILE = path.join(ROOT, '.folio', 'publish-status.json');
const REVISION = 'a'.repeat(64);
let passed = 0;

function harness(options = {}) {
  let now = 100000;
  let sequence = 0;
  const timers = new Map();
  const files = new Map();
  const notices = [];
  const calls = [];
  const children = [];
  const saved = [];
  const storageReads = [];
  const deadPids = new Set();
  const signals = [];
  const settings = Object.hasOwn(options, 'localSettings') ? options.localSettings
    : { projectRoot: ROOT, nodePath: '/runtime/node', pathAdditions: '/tools/bin\n/helpers', siteUrl: 'https://site.example/', ...options.settings };

  class Element {
    constructor(tag = 'div', doc = { activeElement: null }) {
      this.tag = tag;
      this.ownerDocument = doc;
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this.text = '';
    }
    empty() { this.children = []; this.text = ''; }
    createEl(tag, attributes = {}) {
      const element = new Element(tag, this.ownerDocument);
      element.text = attributes.text || '';
      element.attributes = { ...attributes };
      this.children.push(element);
      return element;
    }
    createDiv(attributes) { return this.createEl('div', attributes); }
    addClass(value) { this.attributes.cls = value; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, listener) { this.listeners[event] = listener; }
    focus() { this.ownerDocument.activeElement = this; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join('\n'); }
    all(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.all(tag)]); }
  }
  class Modal {
    constructor(app) {
      this.app = app;
      this.modalEl = new Element('div', { activeElement: null });
      this.contentEl = this.modalEl.createDiv();
      this.openCount = 0;
    }
    setTitle(value) { this.title = value; }
    open() { this.openCount++; this.onOpen(); }
    close() { this.onClose(); }
  }
  class Plugin {
    constructor(app) { this.app = app; this.manifest = manifest; this.commands = []; this.tabs = []; }
    async loadData() { storageReads.push('bootstrap'); await Promise.resolve(); return options.bootstrap || null; }
    saveData() { throw new Error('Bootstrap configuration must not be written by the plugin'); }
    addCommand(command) { this.commands.push(command); }
    addSettingTab(tab) { this.tabs.push(tab); }
  }
  class PluginSettingTab {
    constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new Element(); }
  }
  class Setting {
    constructor(container) { this.container = container; }
    setName(value) { this.name = value; return this; }
    setDesc() { return this; }
    addText(build) { return this.input(build); }
    addTextArea(build) { return this.input(build); }
    input(build) {
      const input = { setValue() { return this; }, onChange(listener) { this.change = listener; return this; } };
      build(input);
      this.container.inputs ||= [];
      this.container.inputs.push(input);
      return this;
    }
  }
  class Notice { constructor(text, duration) { notices.push({ text, duration }); } }
  class Child extends EventEmitter {
    constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.killCount = 0; }
    kill() { this.killCount++; }
    send(event, newline = true) { this.stdout.emit('data', Buffer.from(JSON.stringify(event) + (newline ? '\n' : ''))); }
    close(code = 0, signal = null) { this.stdout.emit('end'); this.emit('close', code, signal); }
  }
  const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' });
  const stat = file => {
    if (options.readError) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const data = files.get(file);
    if (!data) throw missing();
    return { size: Buffer.byteLength(data.raw), mtimeMs: data.mtime };
  };
  const read = file => {
    stat(file);
    return files.get(file).raw;
  };
  const mockFs = { statSync: stat, readFileSync: read, promises: { stat: async file => stat(file), readFile: async file => read(file) } };
  const app = {
    workspace: { getLeavesOfType: type => type === 'markdown' ? (options.views || []).map(view => ({ view })) : [] },
    loadLocalStorage() { storageReads.push('device'); return settings; },
    saveLocalStorage(key, value) { saved.push({ key, value }); },
  };
  const context = {
    module: { exports: {} }, URL, Date: { now: () => now },
    process: { env: { PATH: '/system/bin', FOLIO_TEST: 'inherited' }, kill(pid, signal) {
      signals.push({ pid, signal });
      if (deadPids.has(pid)) throw Object.assign(new Error('not running'), { code: 'ESRCH' });
    } },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(id) {
      if (id === 'obsidian') return { Plugin, Modal, Setting, PluginSettingTab, Notice };
      if (id === 'node:fs') return mockFs;
      if (id === 'node:path') return path;
      if (id === 'node:string_decoder') return { StringDecoder };
      if (id === 'node:child_process') return { spawn(command, args, config) {
        calls.push({ command, args: Array.from(args), config });
        if (options.spawnError) throw new Error('spawn failed');
        const child = new Child(); children.push(child); return child;
      } };
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(source, context, { filename: 'folio-publish/main.js' });
  const plugin = new context.module.exports(app);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    plugin, notices, calls, children, saved, storageReads, timers, deadPids, signals,
    start: async () => plugin.onload(),
    press: () => plugin.commands.find(command => command.id === 'publish').callback(),
    writeStatus(event, mtime = ++now) { files.set(STATUS_FILE, { raw: typeof event === 'string' ? event : JSON.stringify(event), mtime }); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.callback(); }
      }
      await flush();
    },
    flush,
    final(status) {
      assert.equal(plugin.state.status, status);
      assert.equal(plugin.state.busy, false);
      assert.equal(plugin.active, null);
      assert.equal(timers.size, 0, 'terminal results clean up all timers');
      assert.ok(plugin.state.title && !plugin.state.title.includes('Executing'));
      assert.ok(notices.every(notice => notice.duration > 0 && notice.duration <= 9000));
    },
  };
}

async function test(name, run) {
  await run();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

await test('installation bootstrap is awaited and device-local settings override it without writing data.json', async () => {
  const bootstrap = { projectRoot: ROOT, nodePath: '/bootstrap/node', pathAdditions: '/bootstrap/tools', siteUrl: 'https://bootstrap.example/' };
  const h = harness({ bootstrap, localSettings: { nodePath: '/device/node', siteUrl: '', pathAdditions: ['invalid'] } });
  const loading = h.start();
  assert.deepEqual(h.storageReads, ['bootstrap']);
  await loading;
  assert.deepEqual(h.storageReads, ['bootstrap', 'device']);
  assert.equal(h.plugin.settings.projectRoot, ROOT);
  assert.equal(h.plugin.settings.nodePath, '/device/node');
  assert.equal(h.plugin.settings.siteUrl, '', 'an explicitly empty device setting overrides bootstrap');
  assert.equal(h.plugin.settings.pathAdditions, '/bootstrap/tools', 'invalid device field does not override a valid bootstrap field');
  h.press();
  assert.equal(h.calls[0].command, '/device/node');
  assert.equal(h.calls[0].config.cwd, ROOT);
  assert.equal(h.calls[0].config.env.PATH, ['/bootstrap/tools', '/system/bin'].join(path.delimiter));
  h.children[0].send({ type: 'result', status: 'unchanged' }); h.final('unchanged');
  h.plugin.tabs[0].display();
  h.plugin.tabs[0].containerEl.inputs[0].change('/device/project');
  assert.equal(h.saved[0].value.projectRoot, '/device/project');
  assert.equal(bootstrap.projectRoot, ROOT, 'subsequent changes do not mutate bootstrap');
  const firstInstall = harness({ bootstrap, localSettings: null }); await firstInstall.start();
  assert.equal(firstInstall.plugin.settings.nodePath, '/bootstrap/node');
  const defaults = harness({ bootstrap: null, localSettings: null }); await defaults.start();
  assert.equal(defaults.plugin.settings.projectRoot, '');
  assert.equal(defaults.plugin.settings.nodePath, 'node');
});

await test('command spawns direct node with cwd and configured PATH, then automatically publishes', async () => {
  const h = harness(); await h.start();
  assert.equal(h.plugin.commands[0].name, '发布网站');
  h.press();
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.command, '/runtime/node');
  assert.deepEqual(call.args, [path.join(ROOT, 'scripts', 'publish.mjs'), '--json']);
  assert.equal(call.config.cwd, ROOT);
  assert.equal(call.config.shell, false);
  assert.equal(call.config.env.PATH, ['/tools/bin', '/helpers', '/system/bin'].join(path.delimiter));
  assert.equal(call.config.env.FOLIO_TEST, 'inherited');
  const child = h.children[0];
  const event = Buffer.from(JSON.stringify({ type: 'diff', added: ['笔记/<unsafe>.md'], modified: ['更新.md'], removed: ['旧稿.md'], revision: REVISION }) + '\r\n');
  const split = event.indexOf(Buffer.from('笔')) + 1;
  child.stdout.emit('data', event.subarray(0, split));
  child.stdout.emit('data', event.subarray(split));
  assert.equal(h.plugin.state.diff.added[0], '笔记/<unsafe>.md', 'split UTF-8 survives');
  assert.match(h.plugin.modal.contentEl.textContent, /新增 1 · 修改 1 · 删除 1/);
  assert.equal(h.plugin.state.revision, REVISION);
  assert.ok(!h.plugin.modal.contentEl.textContent.includes(REVISION), 'revision hashes are not shown in the modal');
  const details = h.plugin.modal.contentEl.all('details')[0];
  assert.equal(details.all('li').length, 0, 'collapsed file lists stay lightweight');
  details.open = true; details.listeners.toggle();
  assert.equal(details.all('li')[0].text, '笔记/<unsafe>.md', 'paths are text, never HTML');
  assert.deepEqual(h.plugin.modal.contentEl.all('button').map(button => button.text), ['收起'], 'no review or approval action');
  for (const [phase, title] of [['uploading', '上传文件'], ['deploying', '部署网站'], ['verifying', '确认网站']]) {
    child.send({ type: 'progress', phase, message: phase });
    assert.equal(h.plugin.state.title, title);
    assert.equal(h.plugin.state.busy, true);
  }
  assert.equal(h.notices.length, 0, 'no indefinite running notification');
  child.send({ type: 'result', status: 'published', message: '网站版本已确认', site: 'https://site.example/', url: 'https://deploy.example/42', revision: REVISION }, false);
  child.close();
  h.final('published');
  assert.equal(h.plugin.state.title, '网站已发布并确认');
  assert.ok(!h.plugin.modal.contentEl.textContent.includes(REVISION), 'final modal also hides revision hashes');
  assert.equal(h.plugin.state.diff.removed[0], '旧稿.md');
  const links = h.plugin.modal.contentEl.all('a');
  assert.deepEqual(links.map(link => link.attributes.href), ['https://site.example/', 'https://deploy.example/42']);
  assert.ok(links.every(link => link.attributes.rel === 'noopener noreferrer'));
});

await test('publishing waits for editor saves and never uploads after a failed save or unloading', async () => {
  let complete;
  let saves = 0;
  const saved = new Promise(resolve => { complete = resolve; });
  const view = { file: { path: 'latest.md' }, save: () => { saves++; return saved; } };
  const h = harness({ views: [view, view] }); await h.start(); h.press();
  assert.equal(saves, 1);
  assert.equal(h.calls.length, 0, 'content diff cannot run before the editor is saved');
  h.press(); assert.equal(saves, 1, 'repeated shortcuts while saving do not start another operation');
  complete(); await h.flush();
  assert.equal(h.calls.length, 1);
  h.children[0].send({ type: 'result', status: 'unchanged' }); h.final('unchanged');

  const failed = harness({ views: [{ file: { path: 'latest.md' }, save: async () => { throw new Error('disk full'); } }] });
  await failed.start(); failed.press(); await failed.flush(); failed.final('failed');
  assert.equal(failed.calls.length, 0);
  assert.match(failed.plugin.state.message, /保存.*disk full/);

  let finish;
  const unloaded = harness({ views: [{ file: { path: 'latest.md' }, save: () => new Promise(resolve => { finish = resolve; }) }] });
  await unloaded.start(); unloaded.press(); unloaded.plugin.onunload(); finish(); await unloaded.flush();
  assert.equal(unloaded.calls.length, 0, 'unloading before a save completes cannot launch a detached operation');
});

await test('active hotkeys focus one modal; every hotkey after completion starts a fresh check in that modal', async () => {
  const h = harness(); await h.start(); h.press();
  const modal = h.plugin.modal;
  h.press();
  assert.equal(h.calls.length, 1);
  assert.equal(modal.modalEl.ownerDocument.activeElement, modal.modalEl);
  h.children[0].send({ type: 'diff', added: ['new.md'], modified: [], removed: [] });
  modal.close();
  assert.equal(h.plugin.state.busy, true);
  assert.equal(h.children[0].killCount, 0);
  h.children[0].send({ type: 'progress', phase: 'verifying', message: '确认中' });
  h.press();
  assert.equal(h.plugin.modal, modal);
  assert.match(modal.contentEl.textContent, /确认中/);
  assert.match(modal.contentEl.textContent, /新增 1/);
  modal.close();
  h.children[0].send({ type: 'result', status: 'published', message: '完成' });
  h.final('published');
  h.press();
  assert.equal(h.calls.length, 2, 'even an unseen final result is replaced by a fresh check');
  assert.equal(h.plugin.modal, modal);
  assert.equal(h.plugin.state.result, null);
  assert.equal(h.plugin.state.diff, null);
  assert.match(modal.contentEl.textContent, /检查变更/);
  assert.ok(!modal.contentEl.textContent.includes('网站已发布并确认'));
  h.children[0].emit('close', 1);
  assert.equal(h.plugin.state.busy, true, 'a prior process cannot finish the new operation');
  h.children[1].send({ type: 'diff', added: ['新文章.md'], modified: [], removed: [] });
  assert.match(modal.contentEl.textContent, /新增 1/);
  assert.equal(h.plugin.state.diff.added[0], '新文章.md');
  h.press(); assert.equal(h.calls.length, 2, 'repeating during the new operation only focuses');
  h.children[1].send({ type: 'result', status: 'published', message: '新文章已发布并确认' }); h.final('published');
  assert.match(modal.contentEl.textContent, /新文章已发布并确认/);
  h.press();
  assert.equal(h.calls.length, 3, 'a visible final result also starts a fresh check');
  assert.equal(h.plugin.modal, modal);
  assert.equal(h.plugin.state.result, null);
  assert.equal(h.plugin.state.diff, null);
  assert.match(modal.contentEl.textContent, /检查变更/);
  assert.ok(!modal.contentEl.textContent.includes('新文章已发布并确认'));
  h.children[2].send({ type: 'diff', added: ['下一篇文章.md'], modified: ['新文章.md'], removed: [] });
  assert.match(modal.contentEl.textContent, /新增 1 · 修改 1 · 删除 0/);
  h.children[2].send({ type: 'result', status: 'published', message: '最新文章已发布并确认' }); h.final('published');
  assert.equal(h.plugin.state.diff.added[0], '下一篇文章.md');
  assert.match(modal.contentEl.textContent, /最新文章已发布并确认/);
});

await test('unchanged, warning, pending and failed results have distinct Chinese final states', async () => {
  for (const [status, title] of [
    ['unchanged', '没有变更，已跳过发布'], ['published_with_warning', '已发布，但有提醒'],
    ['pending', '发布尚未获得最终确认'], ['failed', '发布失败'],
  ]) {
    const h = harness(); await h.start(); h.press();
    h.children[0].send({ type: 'result', status, message: '结果说明' });
    h.final(status); assert.equal(h.plugin.state.title, title);
    assert.match(h.plugin.modal.contentEl.textContent, /结果说明/);
    h.children[0].close(status === 'failed' ? 1 : 0); h.final(status);
  }
});

await test('safe progress links remain available while building and survive final results or UI timeout', async () => {
  for (const outcome of ['failed', 'published', 'timeout']) {
    const h = harness(); await h.start(); h.press();
    const links = () => h.plugin.modal.contentEl.all('a').map(link => link.attributes.href);
    h.children[0].send({ type: 'progress', phase: 'deploying', site: 'https://live.example/', url: 'https://deploy.example/first' });
    assert.equal(h.plugin.state.busy, true);
    assert.equal(h.plugin.state.status, 'deploying');
    assert.equal(h.plugin.state.result, null, 'a website link is not success confirmation');
    assert.deepEqual(links(), ['https://live.example/', 'https://deploy.example/first']);
    h.children[0].send({ type: 'progress', phase: 'verifying', site: { url: 'https://live.example/latest' }, url: 'https://deploy.example/latest' });
    h.children[0].send({ type: 'progress', phase: 'verifying', site: 'javascript:bad', url: 'data:text/html,bad' });
    assert.deepEqual(links(), ['https://live.example/latest', 'https://deploy.example/latest'], 'unsafe URLs never replace safe context');
    h.plugin.modal.close(); h.press();
    assert.deepEqual(links(), ['https://live.example/latest', 'https://deploy.example/latest'], 'links survive modal reopening');
    if (outcome === 'timeout') await h.advance(30 * 60 * 1000);
    else h.children[0].send({ type: 'result', status: outcome, message: '最终结果没有附带链接' });
    h.final(outcome === 'timeout' ? 'pending' : outcome);
    assert.deepEqual(links(), ['https://live.example/latest', 'https://deploy.example/latest']);
    if (outcome === 'timeout') {
      h.children[0].send({ type: 'result', status: 'published' });
      h.final('pending');
      h.plugin.modal.close(); h.press();
      assert.deepEqual(links(), ['https://site.example/'], 'new operations do not retain a previous deployment URL');
      h.children[1].send({ type: 'result', status: 'unchanged' }); h.final('unchanged');
    }
  }
});

await test('exit without result is failure, including zero exit, malformed JSON and abrupt signal', async () => {
  for (const kind of ['zero', 'bad-json', 'signal', 'unknown-result']) {
    const h = harness(); await h.start(); h.press();
    if (kind === 'bad-json') h.children[0].stdout.emit('data', Buffer.from('not json\n'));
    if (kind === 'unknown-result') h.children[0].send({ type: 'result', status: 'success' });
    h.children[0].close(kind === 'signal' ? null : 0, kind === 'signal' ? 'SIGTERM' : null);
    h.final('failed'); assert.match(h.plugin.state.message, /未|未知/);
  }
});

await test('spawn, child and stream errors clear busy and cannot be overwritten by close', async () => {
  for (const kind of ['spawn', 'child', 'stdout', 'stderr', 'output-close']) {
    const h = harness({ spawnError: kind === 'spawn' }); await h.start(); h.press();
    if (kind !== 'spawn') {
      const child = h.children[0];
      if (kind === 'child') child.emit('error', new Error('ENOENT'));
      else if (kind === 'output-close') child.stdout.emit('close');
      else child[kind].emit('error', new Error('read failed'));
      child.close();
    }
    h.final('failed');
  }
});

await test('inherited open pipes, silent processes and oversized output are bounded', async () => {
  const h = harness(); await h.start(); h.press(); h.children[0].emit('exit', 0, null);
  await h.advance(2000); h.final('failed');
  const silent = harness(); await silent.start(); silent.press();
  await silent.advance(30 * 60 * 1000); silent.final('pending');
  assert.equal(silent.children[0].killCount, 0);
  const large = harness(); await large.start(); large.press();
  large.children[0].stdout.emit('data', Buffer.from('x'.repeat(1024 * 1024 + 1)));
  large.final('failed');
});

await test('already_running follows the owner file through verification and final result, never spawning twice', async () => {
  const h = harness(); await h.start();
  const owner = { pid: 12345, sessionId: 'owner-session', updatedAt: '2026-11-08T00:00:00Z' };
  h.writeStatus({ type: 'progress', phase: 'deploying', message: '部署中', ...owner });
  h.press();
  h.children[0].send({ type: 'result', status: 'already_running', pid: 67890, sessionId: 'duplicate-session' });
  h.children[0].close(); await h.flush();
  assert.equal(h.plugin.state.busy, true);
  assert.equal(h.plugin.state.title, '部署网站');
  h.plugin.modal.close(); h.press(); assert.equal(h.calls.length, 1);
  h.writeStatus({ type: 'progress', phase: 'verifying', message: '正在确认', ...owner });
  await h.advance(1500); assert.equal(h.plugin.state.title, '确认网站');
  h.writeStatus({ type: 'result', status: 'published', message: '版本已确认', site: 'https://site.example/', ...owner });
  await h.advance(1500); h.final('published');
  assert.ok(h.signals.every(signal => signal.signal === 0), 'PID probes never signal the process');
});

await test('unchanged stale final records, including a dead PID or touched file, finish pending after a short owner grace', async () => {
  for (const variant of ['live', 'dead', 'touched']) {
    const h = harness(); await h.start();
    const stale = { type: 'result', status: 'published', message: 'previous run', pid: 123, sessionId: 'old' };
    h.writeStatus(stale);
    if (variant !== 'live') h.deadPids.add(123);
    h.press();
    if (variant === 'touched') h.writeStatus(stale);
    h.children[0].send({ type: 'result', status: 'already_running' }); h.children[0].close();
    await h.flush();
    for (let poll = 0; poll < 3; poll++) {
      await h.advance(1500);
      assert.equal(h.plugin.state.busy, true);
      assert.notEqual(h.plugin.state.status, 'published');
    }
    await h.advance(1500); h.final('pending');
    assert.match(h.plugin.state.message, /记录可能已过期/);
    assert.match(h.plugin.state.message, /重试/);
    assert.ok(!h.plugin.modal.contentEl.textContent.includes('previous run'));
    assert.equal(h.children[0].killCount, 0);
  }
});

await test('a live owner discovered within the grace follows normally, with the full 20 minute bound', async () => {
  const h = harness(); await h.start();
  h.writeStatus({ type: 'result', status: 'published', pid: 123, sessionId: 'old' });
  h.deadPids.add(123);
  h.press(); h.children[0].send({ type: 'result', status: 'already_running' }); await h.flush();
  await h.advance(4500);
  h.writeStatus({ type: 'progress', phase: 'deploying', pid: 124, sessionId: 'current' });
  await h.advance(1500);
  await h.advance(6000);
  assert.equal(h.plugin.state.busy, true, 'verified active progress continues beyond the short grace');
  h.writeStatus({ type: 'result', status: 'published', pid: 124, sessionId: 'current' });
  await h.advance(1500); h.final('published');
  const timeout = harness(); await timeout.start();
  timeout.writeStatus({ type: 'progress', phase: 'verifying', pid: 125, sessionId: 'active' });
  timeout.press(); timeout.children[0].send({ type: 'result', status: 'already_running' }); await timeout.flush();
  await timeout.advance(20 * 60 * 1000); timeout.final('pending');
  assert.match(timeout.plugin.state.message, /20 分钟/);
});

await test('following stops at a dead owner, missing owner file timeout, and status permission errors', async () => {
  const dead = harness(); await dead.start();
  dead.writeStatus({ type: 'progress', phase: 'uploading', pid: 77, sessionId: 'running' });
  dead.press(); dead.children[0].send({ type: 'result', status: 'already_running' });
  await dead.flush(); dead.deadPids.add(77); await dead.advance(1500); dead.final('failed');
  assert.match(dead.plugin.state.message, /原发布进程已结束/);
  const missing = harness(); await missing.start(); missing.press();
  missing.children[0].send({ type: 'result', status: 'already_running', ownerPid: 78, ownerSessionId: 'owner' });
  missing.deadPids.add(78); await missing.flush(); missing.final('failed');
  const timeout = harness(); await timeout.start(); timeout.press();
  timeout.children[0].send({ type: 'result', status: 'already_running' }); await timeout.flush();
  await timeout.advance(6000); timeout.final('pending');
  assert.match(timeout.plugin.state.message, /未能确认正在运行/);
  const denied = harness({ readError: true }); await denied.start(); denied.press();
  denied.children[0].send({ type: 'result', status: 'already_running' }); await denied.flush(); denied.final('failed');
});

await test('following tolerates incomplete status JSON and ignores a different owner session', async () => {
  const h = harness(); await h.start(); h.press();
  h.writeStatus('{');
  h.children[0].send({ type: 'result', status: 'already_running', ownerPid: 81, ownerSessionId: 'owner' });
  await h.flush(); assert.equal(h.plugin.state.busy, true);
  h.writeStatus({ type: 'result', status: 'published', sessionId: 'other', pid: 82 });
  await h.advance(1500); assert.equal(h.plugin.state.busy, true);
  h.writeStatus({ type: 'result', status: 'published_with_warning', message: '提醒', sessionId: 'owner', pid: 81 });
  await h.advance(1500); h.final('published_with_warning');
});

await test('unload clears timers and busy while leaving publication and output streams alone', async () => {
  const h = harness(); await h.start(); h.press();
  h.children[0].send({ type: 'result', status: 'already_running' }); await h.flush();
  h.plugin.onunload();
  assert.equal(h.plugin.state.busy, false);
  assert.equal(h.plugin.active, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.children[0].killCount, 0);
  const notices = h.notices.length;
  h.children[0].send({ type: 'result', status: 'published' });
  h.children[0].stdout.emit('error', new Error('late stream error'));
  h.children[0].emit('error', new Error('late child error'));
  h.children[0].close(); await h.flush();
  assert.equal(h.timers.size, 0);
  assert.equal(h.notices.length, notices);
  assert.notEqual(h.plugin.state.status, 'published');
});

await test('settings stay device-local; missing configuration fails without spawn; unsafe URLs never link', async () => {
  const h = harness(); await h.start();
  h.plugin.tabs[0].display();
  h.plugin.tabs[0].containerEl.inputs[0].change('/another/project');
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].value.projectRoot, '/another/project');
  const empty = harness({ settings: { projectRoot: '' } }); await empty.start(); empty.press();
  empty.final('failed'); assert.equal(empty.calls.length, 0);
  const urls = harness({ settings: { siteUrl: 'javascript:alert(1)' } }); await urls.start(); urls.press();
  urls.children[0].send({ type: 'result', status: 'published', site: 'data:text/html,bad', url: 'javascript:bad' });
  urls.final('published'); assert.equal(urls.plugin.modal.contentEl.all('a').length, 0);
  assert.equal(manifest.id, 'folio-publish'); assert.equal(manifest.isDesktopOnly, true);
});

console.log(`Passed ${passed} Obsidian publishing plugin regression checks.`);
