const { Plugin, Modal, Setting, PluginSettingTab, Notice } = require('obsidian');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_SETTINGS = Object.freeze({ projectRoot: '', nodePath: 'node', pathAdditions: '', siteUrl: '' });
const STORAGE_KEY = 'folio-publish-settings';
const MAX_LINE = 1024 * 1024;
const MAX_STATUS = 128 * 1024;
const FOLLOW_INTERVAL = 1500;
const FOLLOW_OWNER_GRACE = 6000;
const FOLLOW_TIMEOUT = 20 * 60 * 1000;
const PHASES = { checking: '检查变更', uploading: '上传文件', deploying: '部署网站', verifying: '确认网站' };
const RESULTS = {
  unchanged: '没有变更，已跳过发布',
  published: '网站已发布并确认',
  published_with_warning: '已发布，但有提醒',
  pending: '发布尚未获得最终确认',
  failed: '发布失败',
};

function httpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function latestLinks(previous, event) {
  const links = { ...previous };
  const site = httpUrl(typeof event.site === 'string' ? event.site : event.site?.url);
  const url = httpUrl(event.url);
  if (site) links.site = site;
  if (url) links.url = url;
  return links;
}

function snapshotSync(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_STATUS) return null;
    return { raw: fs.readFileSync(file, 'utf8'), mtime: stat.mtimeMs };
  } catch { return null; }
}

function sameSnapshot(left, right) {
  // Touching the same old result file is not evidence of a new confirmation.
  return !!left && left.raw === right.raw;
}

class PublishModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.opened = false;
  }

  onOpen() {
    this.opened = true;
    this.modalEl.addClass('folio-publish-modal');
    this.render();
    this.focus();
  }

  focus() {
    // Modal elements belong to the current Obsidian window, including pop-out windows.
    const element = this.modalEl || this.contentEl;
    if (element.ownerDocument) {
      element.setAttribute('tabindex', '-1');
      element.focus();
    }
  }

  onClose() {
    this.opened = false;
    this.contentEl.empty();
  }

  render() {
    if (!this.opened) return;
    const state = this.plugin.state;
    const content = this.contentEl;
    content.empty();
    this.setTitle('发布网站');
    const status = content.createDiv({ cls: `folio-publish-status is-${state.status}` });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.createEl('h3', { text: state.title });
    if (state.message) status.createEl('p', { text: state.message, cls: 'folio-publish-message' });

    if (state.diff) {
      const { added, modified, removed } = state.diff;
      content.createEl('p', {
        text: `新增 ${added.length} · 修改 ${modified.length} · 删除 ${removed.length}`,
        cls: 'folio-publish-counts',
      });
      for (const [title, files] of [['新增', added], ['修改', modified], ['删除', removed]]) {
        if (!files.length) continue;
        const details = content.createEl('details', { cls: 'folio-publish-files' });
        details.createEl('summary', { text: `${title}（${files.length}）` });
        let populated = false;
        details.addEventListener('toggle', () => {
          if (!details.open || populated) return;
          populated = true;
          const list = details.createEl('ul');
          for (const file of files) list.createEl('li', { text: file });
        });
      }
    }

    const site = state.links.site || httpUrl(this.plugin.settings.siteUrl);
    const deployment = state.links.url;
    if (site || deployment) {
      const links = content.createDiv({ cls: 'folio-publish-links' });
      for (const [label, url] of [['打开网站', site], ['查看部署', deployment !== site ? deployment : null]]) {
        if (!url) continue;
        const anchor = links.createEl('a', { text: label, href: url });
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (state.busy) content.createEl('p', {
      text: '正在自动处理。关闭此窗口不会中止发布；再次使用快捷键可查看进度。',
      cls: 'folio-publish-hint',
    });
    const actions = content.createDiv({ cls: 'folio-publish-actions' });
    actions.createEl('button', { text: state.busy ? '收起' : '关闭' }).addEventListener('click', () => this.close());
  }
}

class PublishSettings extends PluginSettingTab {
  display() {
    this.containerEl.empty();
    this.containerEl.createEl('p', { text: '此处修改仅保存在当前设备。快捷键会自动检查变更并发布。' });
    const fields = [
      ['projectRoot', 'Folio 项目目录', '项目的绝对路径，须包含 scripts/publish.mjs。'],
      ['nodePath', 'Node 可执行文件', '填写 node 或 Node 可执行文件的绝对路径，不附加命令参数。'],
      ['pathAdditions', '额外 PATH 目录', '每行一个目录，放在继承的 PATH 前。用于查找发布依赖的本机命令。'],
      ['siteUrl', '网站地址', '可选，作为网站链接的后备地址（http 或 https）。'],
    ];
    for (const [key, title, description] of fields) {
      const setting = new Setting(this.containerEl).setName(title).setDesc(description);
      const build = input => input.setValue(this.plugin.settings[key]).onChange(value => {
        this.plugin.settings[key] = value.trim();
        this.plugin.saveSettings();
      });
      if (key === 'pathAdditions') setting.addTextArea(build);
      else setting.addText(build);
    }
  }
}

module.exports = class FolioPublish extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS };
    // The private vault data.json can seed installation without editing app storage.
    const bootstrap = await this.loadData();
    // Obsidian's per-vault local storage stays on this device, outside vault files.
    const saved = this.app.loadLocalStorage(STORAGE_KEY);
    for (const source of [bootstrap, saved]) {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (typeof source?.[key] === 'string') this.settings[key] = source[key];
      }
    }
    this.disposed = false;
    this.active = null;
    this.children = new Set();
    this.state = { busy: false, status: 'idle', title: '准备发布', message: '', diff: null, revision: '', result: null, links: {} };
    this.addCommand({ id: 'publish', name: '发布网站', callback: () => this.publish() });
    this.addSettingTab(new PublishSettings(this.app, this));
  }

  saveSettings() {
    try { this.app.saveLocalStorage(STORAGE_KEY, { ...this.settings }); }
    catch (error) { new Notice(`无法保存本机发布设置：${error.message}`, 8000); }
  }

  showModal() {
    if (!this.modal) this.modal = new PublishModal(this);
    if (this.modal.opened) this.modal.focus();
    else this.modal.open();
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.modal?.render();
  }

  publish() {
    if (this.disposed) return;
    // Only an active operation suppresses a new check; finished results may be stale.
    if (this.active) { this.showModal(); return; }
    this.update({ busy: true, status: 'checking', title: PHASES.checking, message: '', diff: null, revision: '', result: null, links: {} });
    this.showModal();
    const root = this.settings.projectRoot.trim();
    const op = {
      root, child: null, finished: false, buffer: '', decoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'), stderr: '', protocolError: '', stdoutEnded: false,
      following: false, timer: null, expectedSession: null, expectedPid: null,
    };
    this.active = op;
    if (!root || !path.isAbsolute(root)) {
      this.finish(op, { status: 'failed', message: '请先在 Folio 发布设置中填写项目目录的绝对路径。' });
      return;
    }
    op.statusFile = path.join(root, '.folio', 'publish-status.json');
    op.baseline = snapshotSync(op.statusFile);
    const additions = this.settings.pathAdditions.split(/[\r\n]+/).map(value => value.trim()).filter(Boolean);
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = [...additions, env[pathKey] || ''].filter(Boolean).join(path.delimiter);
    try {
      const child = spawn(this.settings.nodePath.trim() || 'node', [path.join(root, 'scripts', 'publish.mjs'), '--json'], {
        cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      op.child = child;
      this.children.add(child);
      child.stdout.on('data', chunk => {
        if (this.isActive(op)) this.readOutput(op, op.decoder.write(chunk));
      });
      child.stdout.on('end', () => this.endOutput(op));
      child.stdout.on('close', () => {
        this.endOutput(op);
        if (this.isActive(op) && !op.following) this.finish(op, {
          status: 'failed', message: '发布输出已关闭，但未返回最终结果；网站尚未确认。',
        });
      });
      child.stderr.on('data', chunk => {
        if (this.isActive(op)) op.stderr = (op.stderr + op.stderrDecoder.write(chunk)).slice(-8192);
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('error', error => {
        this.finish(op, { status: 'failed', message: `读取发布进程输出失败：${error.message}` });
      });
      child.on('error', error => this.finish(op, { status: 'failed', message: `无法运行发布命令：${error.message}` }));
      child.on('close', (code, signal) => {
        this.children.delete(child);
        this.endOutput(op);
        if (!this.isActive(op) || op.following) return;
        const detail = op.protocolError || op.stderr.trim() || (signal ? `信号 ${signal}` : `退出码 ${code}`);
        this.finish(op, { status: 'failed', message: `发布进程已结束，但未返回最终结果；网站尚未确认。${detail ? `\n${detail}` : ''}` });
      });
      // A process can emit exit while an inherited pipe is still open. Never stay busy indefinitely.
      child.on('exit', (code, signal) => {
        if (!this.isActive(op) || op.following) return;
        op.exitTimer = setTimeout(() => {
          if (!this.isActive(op) || op.following) return;
          this.finish(op, { status: 'failed', message: `发布进程已退出（${signal || code}），输出未正常关闭，且未收到最终网站确认。` });
        }, 2000);
      });
      op.timeout = setTimeout(() => this.finish(op, {
        status: 'pending', message: '等待发布超过 30 分钟，尚未收到最终网站确认。发布可能仍在后台运行，可稍后再次检查。',
      }), 30 * 60 * 1000);
    } catch (error) {
      this.finish(op, { status: 'failed', message: `无法启动发布命令：${error.message}` });
    }
  }

  isActive(op) { return !this.disposed && this.active === op && !op.finished; }

  readOutput(op, text) {
    op.buffer += text;
    let newline;
    while (this.isActive(op) && (newline = op.buffer.indexOf('\n')) !== -1) {
      const line = op.buffer.slice(0, newline).trim();
      op.buffer = op.buffer.slice(newline + 1);
      if (line.length > MAX_LINE) { this.outputTooLarge(op); return; }
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { op.protocolError = '发布命令返回了无法解析的 JSON。'; continue; }
      this.receive(op, event);
    }
    if (op.buffer.length > MAX_LINE) this.outputTooLarge(op);
  }

  outputTooLarge(op) {
    op.buffer = '';
    this.finish(op, { status: 'failed', message: '发布命令输出过长，无法读取最终网站确认。发布进程可能仍在后台运行。' });
  }

  endOutput(op) {
    if (!this.isActive(op) || op.stdoutEnded) return;
    op.stdoutEnded = true;
    // Also accept a final JSON line without a trailing newline.
    this.readOutput(op, op.decoder.end() + '\n');
  }

  receive(op, event, fromStatus = false) {
    if (!this.isActive(op) || !event || typeof event !== 'object') return;
    if (event.type === 'progress' && PHASES[event.phase]) {
      this.update({
        status: event.phase, title: PHASES[event.phase], message: typeof event.message === 'string' ? event.message : '',
        links: latestLinks(this.state.links, event),
      });
    } else if (event.type === 'diff') {
      const diff = {};
      for (const key of ['added', 'modified', 'removed']) diff[key] = Array.isArray(event[key]) ? event[key].filter(file => typeof file === 'string') : [];
      this.update({ diff, revision: typeof event.revision === 'string' ? event.revision : this.state.revision });
    } else if (event.type === 'result') {
      if (event.status === 'already_running') {
        if (!fromStatus && !op.following) this.follow(op, event);
      } else if (Object.hasOwn(RESULTS, event.status)) {
        this.finish(op, event);
      } else {
        this.finish(op, { status: 'failed', message: '发布命令返回了未知结果，网站尚未确认。' });
      }
    }
  }

  follow(op, event) {
    op.following = true;
    clearTimeout(op.exitTimer);
    // Generic pid/sessionId metadata may describe the duplicate CLI, not the lock owner.
    op.expectedSession = typeof event.ownerSessionId === 'string' ? event.ownerSessionId : null;
    op.expectedPid = Number.isInteger(event.ownerPid) && event.ownerPid > 0 ? event.ownerPid : null;
    op.ownerVerified = !!op.expectedPid && !this.pidDead(op.expectedPid);
    op.ownerDeadline = Date.now() + FOLLOW_OWNER_GRACE;
    op.deadline = Date.now() + FOLLOW_TIMEOUT;
    this.update({
      status: 'following', title: '正在跟进已有发布', message: '正在读取已有发布状态，等待网站最终确认。',
      links: latestLinks(this.state.links, event),
    });
    this.poll(op);
  }

  async poll(op) {
    if (!this.isActive(op)) return;
    if (Date.now() >= op.deadline) {
      this.finish(op, { status: 'pending', message: '等待已有发布超过 20 分钟，尚未获得网站最终确认。发布可能仍在后台进行，可稍后再次检查。' });
      return;
    }
    try {
      const stat = await fs.promises.stat(op.statusFile);
      if (!this.isActive(op)) return;
      if (stat.size > MAX_STATUS) throw new Error('本地发布状态文件过大');
      const current = { raw: await fs.promises.readFile(op.statusFile, 'utf8'), mtime: stat.mtimeMs };
      if (!this.isActive(op)) return;
      const event = JSON.parse(current.raw);
      const matches = (!op.expectedSession || event.sessionId === op.expectedSession)
        && (!op.expectedPid || event.pid === op.expectedPid);
      const activeProgress = event.type === 'progress' && PHASES[event.phase]
        && Number.isInteger(event.pid) && event.pid > 0 && !this.pidDead(event.pid);
      // An old success file must never become confirmation for a different run.
      const trusted = matches && (op.expectedSession || !sameSnapshot(current, op.baseline)
        || activeProgress);
      if (trusted) {
        if (activeProgress) op.ownerVerified = true;
        if (!op.expectedSession && typeof event.sessionId === 'string') op.expectedSession = event.sessionId;
        if (!op.expectedPid && Number.isInteger(event.pid) && event.pid > 0) op.expectedPid = event.pid;
        this.receive(op, event, true);
        if (!this.isActive(op)) return;
      }
    } catch (error) {
      if (!this.isActive(op)) return;
      // Missing files and a concurrent atomic replacement can be retried locally.
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        this.finish(op, { status: 'failed', message: `无法读取已有发布的本地状态：${error.message}` });
        return;
      }
    }
    if (this.isActive(op) && this.pidDead(op.expectedPid)) {
      this.finish(op, { status: 'failed', message: '原发布进程已结束，但没有返回最终结果；网站尚未确认。请重新检查发布。' });
      return;
    }
    if (this.isActive(op) && !op.ownerVerified && Date.now() >= op.ownerDeadline) {
      this.finish(op, {
        status: 'pending', message: '未能确认正在运行的发布进程，本地状态记录可能已过期，网站尚未确认。请关闭此窗口后重试，或查看网站及部署状态。',
      });
      return;
    }
    const deadline = op.ownerVerified ? op.deadline : Math.min(op.deadline, op.ownerDeadline);
    if (this.isActive(op)) op.timer = setTimeout(() => this.poll(op), Math.min(FOLLOW_INTERVAL, Math.max(0, deadline - Date.now())));
  }

  pidDead(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); }
    catch (error) { return error.code === 'ESRCH'; }
    return false;
  }

  finish(op, result) {
    if (!this.isActive(op)) return;
    op.finished = true;
    clearTimeout(op.timer);
    clearTimeout(op.exitTimer);
    clearTimeout(op.timeout);
    op.buffer = '';
    this.active = null;
    this.update({
      busy: false, status: result.status, title: RESULTS[result.status] || RESULTS.failed,
      message: typeof result.message === 'string' ? result.message : '', result,
      revision: typeof result.revision === 'string' ? result.revision : this.state.revision,
      links: latestLinks(this.state.links, result),
    });
    new Notice(this.state.title, result.status === 'failed' ? 9000 : 6000);
  }

  onunload() {
    // Unloading the UI must not interrupt an authorized publish or its backend cleanup.
    if (this.active) {
      clearTimeout(this.active.timer);
      clearTimeout(this.active.exitTimer);
      clearTimeout(this.active.timeout);
      this.active.finished = true;
      this.state = { ...this.state, status: 'pending', title: RESULTS.pending, message: '发布界面已卸载，发布进程可能仍在后台运行。' };
    }
    this.active = null;
    this.state.busy = false;
    this.disposed = true;
    this.modal?.close();
    // Attached stream handlers keep draining output, but isActive prevents UI updates.
    this.children.clear();
  }
};
