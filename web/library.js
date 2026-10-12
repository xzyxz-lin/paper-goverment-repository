/* 私人文献库 - 前端交互（复用观察台配色/抽屉/卡片框架） */
"use strict";

const API = {
  token: localStorage.getItem("lib_token") || "",
  get user() { return this._user || null; },
  set user(v) { this._user = v; },
};

function authHeader() {
  return API.token ? { "Authorization": "Bearer " + API.token, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function req(method, path, body) {
  const opts = { method, headers: authHeader() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const resp = await fetch(path, opts);
  if (resp.status === 401) {
    // token 只保存在前端内存/本地存储；服务重启后旧 token 会失效。
    // 这里必须直接清理本地状态，不能再调用 req('/api/logout')，否则会在
    // logout 自己返回 401 时递归触发 logout，页面就会卡在“重新登录”状态。
    API.token = "";
    localStorage.removeItem("lib_token");
    showAuth();
    throw new Error("未登录，请重新登录");
  }
  let data = {};
  try { data = await resp.json(); } catch (e) {}
  if (!resp.ok) throw new Error(data.error || ("请求失败 " + resp.status));
  return data;
}

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("is-error", !!isErr);
  t.classList.add("is-show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("is-show"), 2600);
}

/* 带「撤销」按钮的提示条：点了撤销立即执行 fn，默认 8 秒后自动消失 */
function toastAction(msg, actionLabel, fn, ms) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("is-error");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-action";
  btn.textContent = actionLabel || "撤销";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearTimeout(t._t);
    t.classList.remove("is-show");
    fn();
  });
  t.appendChild(btn);
  t.classList.add("is-show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("is-show"), ms || 8000);
}

/* 撤销删除思考：把刚删的条目从删除索引里恢复（后端 /api/note_versions/restore） */
async function undoDeleteNotes(ids, refresh) {
  try {
    for (const id of ids) {
      await req("POST", "/api/note_versions/restore", { note_id: id });
    }
    toast(ids.length > 1 ? `已撤销，${ids.length} 条思考已恢复` : "已撤销，思考已恢复");
    if (refresh) await refresh();
  } catch (e) {
    toast("撤销失败：" + (e.message || "未知错误"), true);
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============ 全局撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y） ============
   会话级操作历史：每个改动型操作成功后 push 一条 {label, undo, redo}。
   - undo / redo 都是 async 闭包，直接调后端接口做逆向操作；
   - 刷新页面后历史清空；
   - 焦点在输入框 / 思考编辑器里时快捷键交给浏览器原生撤销，不抢。 */

const UNDO_STACK = [];
const REDO_STACK = [];
const HISTORY_LIMIT = 50;
let _historyBusy = false;

function pushUndoEntry(entry) {
  UNDO_STACK.push(entry);
  if (UNDO_STACK.length > HISTORY_LIMIT) UNDO_STACK.shift();
  REDO_STACK.length = 0;
}
function pushUndo(label, undo, redo) { pushUndoEntry({ label, undo, redo }); }

async function _historyAct(stackFrom, stackTo, verb) {
  if (_historyBusy) return;
  const entry = stackFrom.pop();
  if (!entry) { toast(verb === "撤销" ? "没有可撤销的操作" : "没有可重做的操作"); return; }
  _historyBusy = true;
  try {
    if (verb === "撤销") await entry.undo();
    else await (entry.redo || entry.undo)();
    stackTo.push(entry);
    toast(verb + "：" + entry.label);
    await refreshAfterHistory();
  } catch (e) {
    stackFrom.push(entry); // 失败放回，历史不丢
    toast(verb + "失败：" + (e.message || "未知错误"), true);
  } finally {
    _historyBusy = false;
  }
}
function doUndo() { return _historyAct(UNDO_STACK, REDO_STACK, "撤销"); }
function doRedo() { return _historyAct(REDO_STACK, UNDO_STACK, "重做"); }

/* 撤销 / 重做后刷新当前视图，保证界面与数据一致 */
async function refreshAfterHistory() {
  try {
    const name = state.currentView; // 视图切换走 class，不看 hidden
    if (name === "paper-view" && state._viewPaper) {
      await openPaperView(state._viewPaper.id);
    } else if (name === "topics") {
      await loadTopicTree();
      if (TOPIC_CURRENT_FILE) {
        const node = findTopicNode(TOPIC_TREE, TOPIC_CURRENT_FILE.id);
        if (node) await openTopicFile(node);
      }
    } else if (name === "recycle") {
      await loadRecycle();
    } else if (name === "project" && state.currentProjectId) {
      await loadTree(state.currentProjectId);
      await loadPapers();
    } else {
      await loadProjects();
    }
  } catch (e) { /* 刷新失败不打断主流程 */ }
}

/* 删除项目/文件夹/论文的撤销：按 entity_id 从回收站找回对应条目并恢复 */
async function restoreRecycleByEntities(kind, entityIds) {
  const d = await req("GET", "/api/recycle");
  const want = new Set(entityIds);
  const ids = (d.items || []).filter(it => it.kind === kind && want.has(it.entity_id)).map(it => it.id);
  if (!ids.length) throw new Error("回收站里没找到对应条目（可能已被清空）");
  await req("POST", "/api/recycle/restore", { ids });
}

/* 恢复被删思考：走后端历史版本接口（与条目上的「撤销」按钮同一通道） */
async function restoreNotesByIds(ids) {
  for (const id of ids) await req("POST", "/api/note_versions/restore", { note_id: id });
}

/* 删除观点节点前抓快照：子树结构 + 各观点名下条目，撤销时按快照重建 */
async function snapshotTopicSubtree(rootId) {
  const nodes = [];
  const noteRefs = [];
  const root = findTopicNode(TOPIC_TREE, rootId);
  async function walk(node, parentId) {
    if (!node) return;
    nodes.push({ id: node.id, kind: node.kind, name: node.name, parent_id: parentId });
    if (node.kind === "topic") {
      try {
        const d = await req("GET", "/api/topics/file?id=" + node.id);
        (d.file.notes || []).forEach(n => noteRefs.push({ noteId: n.id, oldTopicId: node.id }));
      } catch (e) { /* 拿不到条目就只重建结构 */ }
    }
    for (const c of node.children || []) await walk(c, node.id);
  }
  if (root) await walk(root, root.parent_id);
  return { nodes, noteRefs };
}

/* 按快照重建子树（父在前），返回 旧id→新id 映射 */
async function rebuildTopicSubtree(snapshot) {
  const idMap = {};
  for (const n of snapshot.nodes) {
    const d = await req("POST", "/api/topic_nodes", {
      kind: n.kind, name: n.name,
      // 子树内部节点用新 id；根节点的外部父节点不在快照里，直接用原 id 挂回去
      parent_id: n.parent_id != null ? (idMap[n.parent_id] || n.parent_id) : null,
    });
    idMap[n.id] = d.id;
  }
  for (const ref of snapshot.noteRefs) {
    const newId = idMap[ref.oldTopicId];
    if (newId) await req("POST", "/api/notes/assign", { note_id: ref.noteId, topic_file_id: newId });
  }
  return idMap;
}

/* 快捷键：Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做（输入时让给原生撤销） */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = e.target;
  const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
  if (editable) return;
  const key = (e.key || "").toLowerCase();
  if (key === "z") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
  else if (key === "y") { e.preventDefault(); doRedo(); }
});

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// 取光标在 contenteditable 内的字符偏移（用于重渲染后恢复位置）
function getCaretOffset(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return r.toString().length;
}

// 按字符偏移把光标放回 contenteditable
function setCaretOffset(el, offset) {
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = offset, target = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let cur;
  while ((cur = walker.nextNode())) {
    if (remaining <= cur.nodeValue.length) { target = cur; break; }
    remaining -= cur.nodeValue.length;
  }
  const range = document.createRange();
  if (target) { range.setStart(target, remaining); range.collapse(true); }
  else { range.selectNodeContents(el); range.collapse(false); }
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ============ 认证 ============ */
let authMode = "login";

function showAuth() {
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
  updateAuthUI();
}

function showApp() {
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
}

function updateAuthUI() {
  const isLogin = authMode === "login";
  $("#auth-title").textContent = isLogin ? "私人文献库" : "创建账号";
  $("#auth-sub").textContent = isLogin ? "管理你的论文阅读与思考。登录后继续。" : "第一次使用？注册一个自己的账号。";
  $("#auth-submit").textContent = isLogin ? "登录" : "注册";
  $("#auth-switch-line").innerHTML = isLogin
    ? '还没有账号？<button type="button" id="auth-toggle">注册一个</button>'
    : '已有账号？<button type="button" id="auth-toggle">直接登录</button>';
  $("#auth-toggle").addEventListener("click", () => { authMode = isLogin ? "register" : "login"; updateAuthUI(); $("#auth-error").hidden = true; });
  $("#auth-error").hidden = true;
}

function showAuthError(msg) {
  const e = $("#auth-error");
  e.textContent = msg;
  e.hidden = false;
}

async function doAuth() {
  const username = $("#auth-username").value.trim();
  const password = $("#auth-password").value;
  if (!username) { showAuthError("请输入用户名"); return; }
  if (!password) { showAuthError("请输入密码"); return; }
  try {
    const data = await req("POST", authMode === "login" ? "/api/login" : "/api/register", { username, password });
    API.token = data.token;
    localStorage.setItem("lib_token", data.token);
    $("#auth-password").value = "";
    enterApp();
  } catch (e) {
    showAuthError(e.message);
  }
}

function doLogout(redirect = true) {
  const token = API.token;
  API.token = "";
  localStorage.removeItem("lib_token");
  if (redirect) showAuth();
  // 登出请求失败不影响本地登出；直接 fetch 避免经过 401 自动处理逻辑。
  if (token) {
    fetch("/api/logout", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
    }).catch(() => {});
  }
}

/* ============ 应用状态 ============ */
const state = {
  projects: [],
  currentProjectId: null,
  currentProjectName: "",
  folderTree: [],
  currentFolderId: null,
  currentFolderPath: [],   // [{id, name}] 从根到当前
  papers: [],
  recycleItems: [],
  recycleSummary: { total: 0, project: 0, folder: 0, paper: 0 },
  recycleRetentionDays: 7,
  historyTree: [],
  historySel: { projectId: null, folderId: null, paperId: null, eventType: null },
  historyRetentionDays: 7,
  searchTerm: "",
  folderOpen: {},          // folderId -> bool 展开状态
  // 多选删除（仿照论文观察台）
  selPapers: new Set(),    // 当前项目里的论文 id
  selProjects: new Set(),  // 项目卡片 id
  selFolders: new Set(),   // 文件夹 id
  selRecycle: new Set(),   // 回收记录 id
  selNotes: new Set(),     // 当前论文的思考 id（抽屉内批量删除）
  selViewNotes: new Set(), // VIEW 全屏页的思考 id 多选删除
  arrange: null,           // VIEW 大屏拖拽排版状态 { noteId, blocks:[{key,col,order}], dirty }
  selectionAnchor: { paper: null, project: null, folder: null, recycle: null }, // Shift 范围选择的起点
  continuousSelection: false, // 连续选择模式：普通点击直接多选，不必按 Ctrl/Cmd
  currentView: "projects",
  deletedCount: { projects: 0, folders: 0, papers: 0 },
  composeDrafts: new Map(), // paperId -> { html, images } 未保存的思考草稿
};

/* ============ 进入应用 ============ */
async function enterApp() {
  showApp();
  try {
    const me = await req("GET", "/api/me");
    API.user = me.user;
    $("#sidebar-username").textContent = me.user.username;
    $("#service-dot").classList.add("is-live");
    $("#service-state").textContent = "已连接";
    $("#service-addr").textContent = location.host;
    await loadProjects();
    await loadRecycle(false);
    loadDupCount();
    renderNav();
    showView("projects");
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadProjects() {
  const data = await req("GET", "/api/projects");
  state.projects = data.projects;
}

/* ============ 导航 ============ */
function renderNav() {
  const nav = $("#nav-stack");
  let html = `
    <button class="nav-item ${state.currentView === "projects" ? "is-active" : ""}" data-view="projects" type="button">
      <svg><use href="#i-grid"/></svg><span>项目总览</span>
    </button>`;
  const projects = state.projects;
  if (projects.length) {
    html += `<div class="nav-group" style="margin-top:8px;"><div style="padding:0 14px 6px;color:rgba(255,255,255,.4);font:.62rem var(--font-data);letter-spacing:.12em;">我的项目</div>`;
    projects.forEach(p => {
      html += `<button class="nav-item nav-project" data-project="${p.id}" type="button">
        <svg><use href="#i-folder"/></svg><span>${esc(p.name)}</span><b>${p.paper_count || 0}</b>
      </button>`;
    });
    html += `</div>`;
  }
  nav.innerHTML = html;

  $$(".nav-item", nav).forEach(btn => btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    const pid = btn.dataset.project;
    if (view === "projects") { showView("projects"); setActiveNav(btn); }
    else if (pid) { openProject(parseInt(pid)); }
  }));
}

function setActiveNav(btn) {
  $$(".nav-item", $("#nav-stack")).forEach(b => b.classList.remove("is-active"));
  if (btn) btn.classList.add("is-active");
}

/* ============ 视图切换 ============ */
function showView(view) {
  state.currentView = view;
  $$(".page").forEach(p => p.classList.remove("is-visible"));
  const page = $(`.page[data-view="${view}"]`);
  if (page) page.classList.add("is-visible");

  if (view === "projects") {
    $("#page-title").textContent = "项目总览";
    $("#page-eyebrow").textContent = "LIBRARY / OVERVIEW";
    renderProjects();
  } else if (view === "project") {
    $("#page-title").textContent = state.currentProjectName;
    $("#page-eyebrow").textContent = "LIBRARY / PROJECT";
  } else if (view === "recycle") {
    $("#page-title").textContent = "回收站";
    $("#page-eyebrow").textContent = "LIBRARY / RECYCLE BIN";
  } else if (view === "history") {
    $("#page-title").textContent = "历史版本";
    $("#page-eyebrow").textContent = "LIBRARY / HISTORY";
  } else if (view === "paper-view") {
    const p = state._viewPaper;
    $("#page-title").textContent = p ? (p.title_en || p.title_zh || "论文思考") : "论文思考";
    $("#page-eyebrow").textContent = "PAPER / VIEW";
  } else if (view === "topics") {
    $("#page-title").textContent = "观点库";
    $("#page-eyebrow").textContent = "TOPIC LIBRARY";
    loadTopicTree();
  }

  // 在 VIEW 全屏浏览页隐藏 topbar 的「回收站」「新建项目」，避免干扰阅读
  const hideTopActions = view === "paper-view";
  $("#recycle-open-btn").hidden = hideTopActions;
  $("#new-project-btn").hidden = hideTopActions || view === "topics";
  document.body.classList.toggle("view-paper-view", hideTopActions);
}

/* ============ 项目总览 ============ */
function renderProjects() {
  const totalPapers = state.projects.reduce((s, p) => s + (p.paper_count || 0), 0);
  const totalFolders = state.projects.reduce((s, p) => s + (p.folder_count || 0), 0);
  $("#lib-metrics").innerHTML = `
    <div class="lib-metric"><span>项目</span><strong>${state.projects.length}</strong></div>
    <div class="lib-metric"><span>文件夹</span><strong>${totalFolders}</strong></div>
    <div class="lib-metric"><span>论文</span><strong>${totalPapers}</strong></div>`;

  const grid = $("#project-grid");
  if (!state.projects.length) {
    grid.innerHTML = `<div class="empty empty--large"><p>还没有项目。</p><p class="empty-hint">点击右上角「新建项目」，创建你的第一个课题。</p></div>`;
    return;
  }
  grid.innerHTML = state.projects.map(p => `
    <div class="account-card project-card" data-project="${p.id}">
      <label class="lib-sel" data-kind="project" data-id="${p.id}">
        <input type="checkbox" class="lib-sel-chk" data-kind="project" data-id="${p.id}">
      </label>
      <div class="account-card__code">PROJECT <b>#${p.id}</b></div>
      <h4>${esc(p.name)}</h4>
      <p style="margin:0;color:var(--ink-700);font-size:.78rem;">${esc(p.note || "暂无描述")}</p>
      <div class="account-card__stats">
        <div><span>文件夹</span><strong>${p.folder_count || 0}</strong></div>
        <div><span>论文</span><strong>${p.paper_count || 0}</strong></div>
      </div>
    </div>`).join("");
  $$(".project-card", grid).forEach(card => {
    card.addEventListener("click", (e) => {
      // 点击在 checkbox 上 → 切换选择
      if (e.target.closest(".lib-sel")) {
        const id = parseInt(card.dataset.project);
        if (e.shiftKey) {
          rangeSelectInContainer(grid, card, "project");
        } else {
          if (state.selProjects.has(id)) state.selProjects.delete(id);
          else state.selProjects.add(id);
          state.selectionAnchor.project = id;
        }
        updateSelectionUI();
        return;
      }
      handleSelectableClick(card, "project", () => openProject(parseInt(card.dataset.project)), e);
    });
  });
}

/* ============ 多选删除（仿照论文观察台） ============ */
function isAnySelected() {
  return state.selPapers.size + state.selProjects.size + state.selFolders.size;
}

function updateSelectionUI() {
  // 1) 同步所有「已渲染的行」的 .is-selected class
  document.querySelectorAll("[data-pid]").forEach(el => {
    el.classList.toggle("is-selected", state.selPapers.has(parseInt(el.dataset.pid)));
  });
  document.querySelectorAll("[data-project].project-card").forEach(el => {
    el.classList.toggle("is-selected", state.selProjects.has(parseInt(el.dataset.project)));
  });
  document.querySelectorAll("[data-fid].tree-row").forEach(el => {
    el.classList.toggle("is-selected", state.selFolders.has(parseInt(el.dataset.fid)));
  });
  // 2) 同步所有 checkbox 的勾选态
  document.querySelectorAll(".lib-sel-chk").forEach(cb => {
    const kind = cb.dataset.kind;
    const id = parseInt(cb.dataset.id);
    let on = false;
    if (kind === "paper") on = state.selPapers.has(id);
    else if (kind === "project") on = state.selProjects.has(id);
    else if (kind === "folder") on = state.selFolders.has(id);
    cb.checked = on;
  });
  // 3) 批量操作工具条
  const bar = $("#bulk-delete-bar");
  if (!bar) return;
  const total = isAnySelected();
  const continuousBtn = $("#bulk-continuous-selection");
  const deleteBtn = $("#bulk-delete-btn");
  if (total > 0 || state.continuousSelection) {
    bar.hidden = false;
    $("#bulk-delete-count").textContent = state.continuousSelection
      ? `已选中 ${total} 项 · 连续选择已开启`
      : `已选中 ${total} 项`;
    if (continuousBtn) {
      continuousBtn.classList.toggle("is-active", state.continuousSelection);
      continuousBtn.setAttribute("aria-pressed", String(state.continuousSelection));
      continuousBtn.textContent = state.continuousSelection ? "连续选择：开" : "连续选择";
    }
    if (deleteBtn) deleteBtn.disabled = total === 0;
  } else {
    bar.hidden = true;
  }
}

function clearSelection() {
  state.selPapers.clear();
  state.selProjects.clear();
  state.selFolders.clear();
  state.selRecycle.clear();
  state.selectionAnchor = { paper: null, project: null, folder: null, recycle: null };
  updateSelectionUI();
  updateRecycleSelectionUI();
}

// 在某容器内做 Shift 范围选择
function rangeSelectInContainer(container, anchorEl, kind) {
  const set = kind === "paper" ? state.selPapers : (kind === "project" ? state.selProjects : state.selFolders);
  const selector = kind === "paper" ? "[data-pid]" : (kind === "project" ? "[data-project].project-card" : "[data-fid].tree-row");
  const items = Array.from(container.querySelectorAll(selector));
  const dataKey = kind === "paper" ? "pid" : (kind === "project" ? "project" : "fid");
  const b = items.indexOf(anchorEl);
  if (b < 0) return;
  const anchorId = state.selectionAnchor[kind];
  const a = items.findIndex(el => parseInt(el.dataset[dataKey]) === anchorId);
  if (a < 0) {
    set.add(parseInt(anchorEl.dataset[dataKey]));
    state.selectionAnchor[kind] = parseInt(anchorEl.dataset[dataKey]);
    return;
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) {
    const el = items[i];
    const id = parseInt(el.dataset[dataKey]);
    set.add(id);
  }
}

// 通用点击处理：单击行为取决于是否按住 Ctrl/Shift/连续选择模式
function handleSelectableClick(el, kind, openFn, e) {
  const id = parseInt(el.dataset[kind === "paper" ? "pid" : (kind === "project" ? "project" : "fid")]);
  if (!id) return;
  const set = kind === "paper" ? state.selPapers : (kind === "project" ? state.selProjects : state.selFolders);
  if (e.ctrlKey || e.metaKey) {
    if (set.has(id)) set.delete(id); else set.add(id);
    state.selectionAnchor[kind] = id;
    updateSelectionUI();
    return;
  }
  if (e.shiftKey) {
    rangeSelectInContainer(el.parentElement, el, kind);
    updateSelectionUI();
    return;
  }
  // 连续选择模式：普通点击直接切换选择，不打开
  if (state.continuousSelection) {
    if (set.has(id)) set.delete(id); else set.add(id);
    state.selectionAnchor[kind] = id;
    updateSelectionUI();
    return;
  }
  // 普通点击：未选中态 → 进选择；已选中态 → 打开
  if (set.size === 0) {
    set.add(id);
    state.selectionAnchor[kind] = id;
    updateSelectionUI();
    return;
  }
  openFn();
}

async function doBulkDelete() {
  const paperIds = [...state.selPapers];
  const folderIds = [...state.selFolders];
  const projectIds = [...state.selProjects];
  if (!paperIds.length && !folderIds.length && !projectIds.length) return;
  if (!confirm(`确认删除 ${paperIds.length + folderIds.length + projectIds.length} 项？\n删除后可在「回收站」一键恢复。`)) return;
  let okCount = 0;
  try {
    if (projectIds.length) {
      const r = await req("POST", "/api/projects/delete", { ids: projectIds });
      okCount += (r.deleted || 0);
      state.selProjects.clear();
    }
    if (folderIds.length) {
      const r = await req("POST", "/api/folders/delete", { ids: folderIds });
      okCount += (r.deleted || 0);
      state.selFolders.clear();
    }
    if (paperIds.length) {
      const r = await req("POST", "/api/papers/delete", { ids: paperIds });
      okCount += (r.deleted || 0);
      state.selPapers.clear();
    }
    // 撤销批量删除 = 按原 id 从回收站恢复；重做 = 再删一遍
    const undoDeletes = async () => {
      if (projectIds.length) await restoreRecycleByEntities("project", projectIds);
      if (folderIds.length) await restoreRecycleByEntities("folder", folderIds);
      if (paperIds.length) await restoreRecycleByEntities("paper", paperIds);
    };
    const redoDeletes = async () => {
      if (projectIds.length) await req("POST", "/api/projects/delete", { ids: projectIds });
      if (folderIds.length) await req("POST", "/api/folders/delete", { ids: folderIds });
      if (paperIds.length) await req("POST", "/api/papers/delete", { ids: paperIds });
    };
    pushUndo("删除 " + okCount + " 项", undoDeletes, redoDeletes);
    toast(`已删除 ${okCount} 项`);
    // 刷新视图
    await loadProjects();
    await loadRecycle(false);
    renderNav();
    if (state.currentProjectId) {
      if (!state.projects.find(p => p.id === state.currentProjectId)) {
        state.currentProjectId = null;
        state.currentFolderId = null;
        state.currentFolderPath = [];
        showView("projects");
        renderProjects();
      } else {
        await loadTree();
        await loadPapers();
      }
    } else {
      renderProjects();
    }
    updateSelectionUI();
  } catch (e) {
    toast("删除失败：" + e.message, true);
  }
}

async function restoreAllDeleted() {
  await openRecycle();
}

/* ============ 回收站 ============ */
async function loadRecycle(render = true) {
  const data = await req("GET", "/api/recycle");
  state.recycleItems = data.items || [];
  state.recycleSummary = data.summary || { total: 0, project: 0, folder: 0, paper: 0 };
  state.recycleRetentionDays = data.retention_days || 7;
  updateRecycleBadges();
  if (render) renderRecycle();
}

function updateRecycleBadges() {
  const count = state.recycleSummary.total || 0;
  const side = $("#recycle-side-count");
  const top = $("#recycle-top-count");
  if (side) { side.hidden = !count; side.textContent = count; }
  if (top) { top.hidden = !count; top.textContent = count; }
}

async function openRecycle() {
  clearSelection();
  try {
    await loadRecycle(false);
    showView("recycle");
    renderNav();
    renderRecycle();
  } catch (e) {
    toast("回收站加载失败：" + e.message, true);
  }
}

function recycleKindLabel(kind) {
  return { project: "项目", folder: "文件夹", paper: "论文" }[kind] || "记录";
}

function formatRecycleTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function renderRecycle() {
  const stats = $("#recycle-stats");
  const list = $("#recycle-list");
  if (!stats || !list) return;
  $("#recycle-retention-days").textContent = `${state.recycleRetentionDays} 天`;
  const summary = state.recycleSummary;
  stats.innerHTML = `
    <div><span>待恢复</span><strong>${summary.total || 0}</strong></div>
    <div><span>项目</span><strong>${summary.project || 0}</strong></div>
    <div><span>文件夹</span><strong>${summary.folder || 0}</strong></div>
    <div><span>论文</span><strong>${summary.paper || 0}</strong></div>`;

  if (!state.recycleItems.length) {
    list.innerHTML = `<div class="recycle-empty"><svg><use href="#i-archive"/></svg><h4>回收站是空的</h4><p>删除的项目、文件夹、论文会在这里保留 ${state.recycleRetentionDays} 天。已删除的思考归到「历史版本」中。</p></div>`;
    updateRecycleSelectionUI();
    return;
  }

  const groups = new Map();
  state.recycleItems.forEach(item => {
    const key = String(item.project_id || item.id);
    if (!groups.has(key)) groups.set(key, { name: item.project_name || "未知项目", items: [] });
    groups.get(key).items.push(item);
  });
  list.innerHTML = [...groups.values()].map(group => `
    <section class="recycle-group">
      <header><span>PROJECT</span><h4>${esc(group.name)}</h4><b>${group.items.length} 项</b></header>
      <div class="recycle-group__items">
        ${group.items.map(item => `
          <article class="recycle-row" data-rid="${item.id}" tabindex="0" role="checkbox" aria-checked="false">
            <label class="lib-sel recycle-row__check" aria-label="选择${esc(item.title)}"><input type="checkbox" class="recycle-chk" data-rid="${item.id}"></label>
            <div class="recycle-row__kind recycle-row__kind--${item.kind}">${recycleKindLabel(item.kind)}</div>
            <div class="recycle-row__main">
              <h5>${esc(item.title)}</h5>
              <p>${item.folder_path ? `${esc(item.folder_path)} · ` : ""}${esc(item.context)}</p>
            </div>
            <div class="recycle-row__time"><span>删除于 ${formatRecycleTime(item.deleted_at)}</span><b class="${item.remaining_days <= 1 ? "is-urgent" : ""}">${item.remaining_days ? `剩余 ${item.remaining_days} 天` : "已到期"}</b></div>
          </article>`).join("")}
      </div>
    </section>`).join("");

  $$(".recycle-row", list).forEach(row => {
    row.addEventListener("click", (e) => handleRecycleClick(row, e));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRecycleClick(row, e); }
    });
  });
  updateRecycleSelectionUI();
}

function rangeSelectRecycle(target) {
  const rows = $$(".recycle-row", $("#recycle-list"));
  const end = rows.indexOf(target);
  const start = rows.findIndex(row => parseInt(row.dataset.rid) === state.selectionAnchor.recycle);
  const targetId = parseInt(target.dataset.rid);
  if (start < 0 || end < 0) {
    state.selRecycle.add(targetId);
    state.selectionAnchor.recycle = targetId;
    return;
  }
  const [lo, hi] = start < end ? [start, end] : [end, start];
  for (let i = lo; i <= hi; i++) state.selRecycle.add(parseInt(rows[i].dataset.rid));
}

function handleRecycleClick(row, e) {
  const id = parseInt(row.dataset.rid);
  if (!id) return;
  if (e.shiftKey) {
    rangeSelectRecycle(row);
  } else {
    if (state.selRecycle.has(id)) state.selRecycle.delete(id);
    else state.selRecycle.add(id);
    state.selectionAnchor.recycle = id;
  }
  updateRecycleSelectionUI();
}

function updateRecycleSelectionUI() {
  const total = state.selRecycle.size;
  $$(".recycle-row").forEach(row => {
    const checked = state.selRecycle.has(parseInt(row.dataset.rid));
    row.classList.toggle("is-selected", checked);
    row.setAttribute("aria-checked", String(checked));
  });
  $$(".recycle-chk").forEach(box => { box.checked = state.selRecycle.has(parseInt(box.dataset.rid)); });
  const toolbar = $("#recycle-toolbar");
  const count = $("#recycle-selection-count");
  const restore = $("#recycle-restore-btn");
  const purge = $("#recycle-purge-btn");
  if (toolbar) toolbar.hidden = total === 0;
  if (count) count.textContent = `已选中 ${total} 项`;
  if (restore) restore.disabled = total === 0;
  if (purge) purge.disabled = total === 0;
}

async function refreshAfterRecycleChange() {
  await loadProjects();
  await loadRecycle(false);
  renderNav();
  if (state.currentProjectId) {
    if (!state.projects.find(p => p.id === state.currentProjectId)) {
      state.currentProjectId = null;
      state.currentFolderId = null;
      showView("projects");
    } else {
      await loadTree();
      await loadPapers();
    }
  }
}

async function restoreSelectedRecycle() {
  const ids = [...state.selRecycle];
  if (!ids.length) return;
  try {
    const data = await req("POST", "/api/recycle/restore", { ids });
    toast(data.message || "已恢复所选内容");
    clearSelection();
    await refreshAfterRecycleChange();
    if (state.currentView === "recycle") renderRecycle();
  } catch (e) {
    toast("恢复失败：" + e.message, true);
  }
}

async function purgeSelectedRecycle() {
  const ids = [...state.selRecycle];
  if (!ids.length) return;
  if (!confirm(`确认永久删除选中的 ${ids.length} 项吗？\n此操作会清理对应的项目、文件夹或论文记录及其截图，且无法恢复。`)) return;
  try {
    const data = await req("POST", "/api/recycle/purge", { ids });
    toast(data.message || "已永久删除所选内容");
    clearSelection();
    await refreshAfterRecycleChange();
    if (state.currentView === "recycle") renderRecycle();
  } catch (e) {
    toast("永久删除失败：" + e.message, true);
  }
}

/* ============ 历史版本 ============ */
async function openHistory() {
  try {
    await loadHistoryVersions();
    state.historySel = { projectId: null, folderId: null, paperId: null, eventType: null };
    showView("history");
    renderNav();
    renderHistoryVersions();
  } catch (e) {
    toast("历史版本加载失败：" + e.message, true);
  }
}

async function loadHistoryVersions() {
  const data = await req("GET", "/api/note_versions");
  state.historyTree = data.tree || [];
  state.historyRetentionDays = data.retention_days || 7;
}

function formatHistoryTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

const HISTORY_EVENT_LABEL = { create: "新增", edit: "修改", delete: "删除" };

function historyNoteTitle(v) {
  const t = (v.content || "").replace(/\[\[img:\d+\]\]/g, " ").replace(/\s+/g, " ").trim();
  if (t) return t.length > 34 ? t.slice(0, 34) + "…" : t;
  const imgCount = (v.image_ids || []).length;
  return imgCount ? `（${imgCount} 张图片）` : "（空）";
}

function renderHistoryVersions() {
  const crumbs = $("#history-crumbs");
  const level = $("#history-level");
  const retentionEl = $("#history-retention-days");
  if (retentionEl) retentionEl.textContent = (state.historyRetentionDays || 7) + " 天";
  if (!level) return;
  if (!state.historyTree.length) {
    level.innerHTML = `<div class="recycle-empty"><svg><use href="#i-clock"/></svg><h4>还没有历史版本</h4><p>新增、修改或删除思考时，会自动按归属保留一条记录（7 天）。</p></div>`;
    if (crumbs) crumbs.innerHTML = "";
    return;
  }

  const { projectId, folderId, paperId, eventType } = state.historySel;
  const tree = state.historyTree;

  // 面包屑
  if (crumbs) {
    const parts = [`<button class="history-crumb" data-level="root" type="button">历史版本</button>`];
    let proj = null, folder = null, paper = null;
    if (projectId != null) {
      proj = tree.find(p => p.project_id === projectId);
      parts.push(`<button class="history-crumb" data-level="project" type="button">${esc(proj ? proj.project_name : "项目")}</button>`);
    }
    if (proj && folderId != null) {
      folder = proj.folders.find(f => f.folder_id === folderId);
      parts.push(`<button class="history-crumb" data-level="folder" type="button">${esc(folder ? folder.folder_path : "文件夹")}</button>`);
    }
    if (folder && paperId != null) {
      paper = folder.papers.find(p => p.paper_id === paperId);
      parts.push(`<button class="history-crumb" data-level="paper" type="button">${esc(paper ? paper.paper_title : "论文")}</button>`);
    }
    if (paper && eventType != null) {
      parts.push(`<span class="history-crumb is-current">${esc(HISTORY_EVENT_LABEL[eventType] || "修改")}的思考</span>`);
    }
    crumbs.innerHTML = parts.join('<span class="history-crumb__sep">/</span>');
    $$(".history-crumb", crumbs).forEach(btn => {
      btn.onclick = () => {
        const lvl = btn.dataset.level;
        if (lvl === "root") state.historySel = { projectId: null, folderId: null, paperId: null, eventType: null };
        else if (lvl === "project") state.historySel = { projectId, folderId: null, paperId: null, eventType: null };
        else if (lvl === "folder") state.historySel = { projectId, folderId, paperId: null, eventType: null };
        else if (lvl === "paper") state.historySel = { projectId, folderId, paperId, eventType: null };
        renderHistoryVersions();
      };
    });
  }

  // 各级列表
  if (projectId == null) {
    level.innerHTML = tree.map(p => `
      <button class="history-node" data-project="${p.project_id}" type="button">
        <span class="history-node__type">项目</span>
        <span class="history-node__name">${esc(p.project_name)}</span>
        <span class="history-node__count">${p.folders.reduce((s, f) => s + f.papers.length, 0)} 条记录</span>
      </button>`).join("");
    $$(".history-node", level).forEach(btn => btn.onclick = () => {
      state.historySel = { projectId: parseInt(btn.dataset.project), folderId: null, paperId: null, eventType: null };
      renderHistoryVersions();
    });
    return;
  }

  const proj = tree.find(p => p.project_id === projectId);
  if (folderId == null) {
    level.innerHTML = proj.folders.map(f => `
      <button class="history-node" data-folder="${f.folder_id}" type="button">
        <span class="history-node__type">文件夹</span>
        <span class="history-node__name">${esc(f.folder_path)}</span>
        <span class="history-node__count">${f.papers.length} 篇论文记录</span>
      </button>`).join("");
    $$(".history-node", level).forEach(btn => btn.onclick = () => {
      state.historySel = { projectId, folderId: parseInt(btn.dataset.folder), paperId: null, eventType: null };
      renderHistoryVersions();
    });
    return;
  }

  const folder = proj.folders.find(f => f.folder_id === folderId);
  if (paperId == null) {
    level.innerHTML = folder.papers.map(p => `
      <button class="history-node" data-paper="${p.paper_id}" type="button">
        <span class="history-node__type">论文</span>
        <span class="history-node__name">${esc(p.paper_title)}</span>
        <span class="history-node__count">${p.events.length} 条记录</span>
      </button>`).join("");
    $$(".history-node", level).forEach(btn => btn.onclick = () => {
      state.historySel = { projectId, folderId, paperId: parseInt(btn.dataset.paper), eventType: null };
      renderHistoryVersions();
    });
    return;
  }

  const paper = folder.papers.find(p => p.paper_id === paperId);

  // 论文内：先选事件类型（新增 / 修改 / 删除），再查看列表
  if (eventType == null) {
    const groups = [
      { type: "create", label: "新增的思考", items: paper.events.filter(e => e.event_type === "create") },
      { type: "edit", label: "修改的思考", items: paper.events.filter(e => e.event_type === "edit") },
      { type: "delete", label: "删除的思考", items: paper.events.filter(e => e.event_type === "delete") },
    ].filter(g => g.items.length);

    if (!groups.length) {
      level.innerHTML = `<div class="recycle-empty"><svg><use href="#i-clock"/></svg><h4>这篇论文还没有历史记录</h4></div>`;
      return;
    }

    level.innerHTML = groups.map(group => `
      <button class="history-node history-node--event" data-event-type="${group.type}" type="button">
        <span class="history-node__type history-node__type--${group.type}">${esc(HISTORY_EVENT_LABEL[group.type])}</span>
        <span class="history-node__name">${esc(group.label)}</span>
        <span class="history-node__count">${group.items.length} 条</span>
      </button>`).join("");
    $$(".history-node", level).forEach(btn => btn.onclick = () => {
      state.historySel = { projectId, folderId, paperId, eventType: btn.dataset.eventType };
      renderHistoryVersions();
    });
    return;
  }

  // 事件列表
  const items = paper.events.filter(e => e.event_type === eventType)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!items.length) {
    level.innerHTML = `<div class="recycle-empty"><svg><use href="#i-clock"/></svg><h4>该类型下没有历史记录</h4></div>`;
    return;
  }

  const label = HISTORY_EVENT_LABEL[eventType] || "修改";
  level.innerHTML = `
    <p class="history-type-hint">${esc(paper.paper_title)} — ${esc(label)}的思考 · ${items.length} 条</p>
    <div class="history-group__items">
      ${items.map((v, idx) => {
        const text = (v.content || "").replace(/\[\[img:\d+\]\]/g, " [图片] ").replace(/\s+/g, " ").trim();
        const preview = text.length > 160 ? text.slice(0, 160) + "…" : text;
        const imgCount = (v.image_ids || []).length;
        const actions = v.event_type === "delete"
          ? `<button class="scan-button scan-button--ghost scan-button--sm" data-action="view" type="button">查看</button>
             <button class="scan-button scan-button--sm" data-action="restore" type="button">恢复</button>
             <button class="recycle-purge-btn scan-button scan-button--sm" data-action="purge" type="button">彻底删除</button>`
          : `<button class="scan-button scan-button--ghost scan-button--sm" data-action="view" type="button">查看</button>
             <button class="scan-button scan-button--sm" data-action="revert" type="button">回退</button>`;
        return `
        <article class="history-row history-row--${v.event_type}" data-vid="${v.id}" data-nid="${v.note_id}">
          <div class="history-row__main">
            <h5>思考 #${idx + 1} · ${esc(historyNoteTitle(v))}<span> · ${formatHistoryTime(v.created_at)}${imgCount ? ` · ${imgCount} 张图片` : ""}</span></h5>
            ${preview ? `<p class="history-row__preview">${esc(preview)}</p>` : ""}
          </div>
          <div class="history-row__time">
            <span>${esc(HISTORY_EVENT_LABEL[v.event_type] || "修改")}于 ${formatHistoryTime(v.created_at)}</span>
            <b class="${v.remaining_days <= 1 ? "is-urgent" : ""}">${v.remaining_days ? `剩余 ${v.remaining_days} 天` : "已到期"}</b>
          </div>
          <div class="history-row__actions">${actions}</div>
        </article>`;
      }).join("")}
    </div>`;

  $$(".history-row", level).forEach(row => {
    const v = paper.events.find(x => x.id === parseInt(row.dataset.vid));
    row.querySelectorAll("button[data-action]").forEach(btn => {
      btn.onclick = () => {
        const action = btn.dataset.action;
        if (action === "view") viewHistoryVersion(v);
        else if (action === "revert") revertHistoryVersion(v);
        else if (action === "restore") restoreHistoryNote(v);
        else if (action === "purge") purgeHistoryVersion(v);
      };
    });
  });
}

async function restoreHistoryNote(v) {
  if (!confirm("确定恢复这条已删除的思考？它会重新出现在论文抽屉里。")) return;
  try {
    await req("POST", "/api/note_versions/restore", { note_id: v.note_id });
    toast("已恢复该思考");
    await loadHistoryVersions();
    renderHistoryVersions();
  } catch (e) {
    toast("恢复失败：" + e.message, true);
  }
}

async function purgeHistoryVersion(v) {
  if (!confirm("确定彻底删除这条历史记录？若为删除类记录，对应思考也会被永久删除，不可恢复。")) return;
  try {
    await req("POST", "/api/note_versions/purge", { ids: [v.id] });
    toast("已彻底删除该历史记录");
    await loadHistoryVersions();
    renderHistoryVersions();
  } catch (e) {
    toast("删除失败：" + e.message, true);
  }
}

async function viewHistoryVersion(v) {
  let bodyHtml = "";
  try {
    const imgIds = (v.image_ids || []);
    let relMap = {};
    if (imgIds.length) {
      const data = await req("GET", "/api/images?ids=" + imgIds.join(","));
      (data.images || []).forEach(im => { relMap[im.id] = im.rel_path; });
    }
    const pseudoNote = {
      content: v.content,
      images: imgIds.map(id => ({ id, rel_path: relMap[id] || "" })).filter(x => x.rel_path),
    };
    bodyHtml = `<div class="pv-card__body" style="margin-top:14px;">${renderViewNoteBlocks(pseudoNote)}</div>`;
  } catch (e) {
    bodyHtml = `<p style="color:var(--danger-600);font-size:.8rem;">加载图片失败：${esc(e.message)}</p>`;
  }
  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">历史版本 · ${HISTORY_EVENT_LABEL[v.event_type] || "修改"} · ${esc((v.created_at || "").replace("T", " ").slice(0, 16))}</p>
    <h3>历史版本</h3>
    <p class="modal-hint">${esc(v.project_name || "")} / ${esc(v.folder_path || "")} / ${esc(v.paper_title || "")}</p>
    ${bodyHtml}`);
  $("#m-close").onclick = closeModal;
}

async function revertHistoryVersion(v) {
  if (!confirm("确定回退到这个版本？当前内容会被保存为一个新版本，方便再次回退。")) return;
  try {
    await req("POST", "/api/note_versions/revert", { note_id: v.note_id, version_id: v.id });
    toast("已回退到选中版本");
    await loadHistoryVersions();
    renderHistoryVersions();
  } catch (e) {
    toast("回退失败：" + e.message, true);
  }
}

function renderProjects() {
  const totalPapers = state.projects.reduce((s, p) => s + (p.paper_count || 0), 0);
  const totalFolders = state.projects.reduce((s, p) => s + (p.folder_count || 0), 0);
  $("#lib-metrics").innerHTML = `
    <div class="lib-metric"><span>项目</span><strong>${state.projects.length}</strong></div>
    <div class="lib-metric"><span>文件夹</span><strong>${totalFolders}</strong></div>
    <div class="lib-metric"><span>论文</span><strong>${totalPapers}</strong></div>`;

  const grid = $("#project-grid");
  if (!state.projects.length) {
    grid.innerHTML = `<div class="empty empty--large"><p>还没有项目。</p><p class="empty-hint">点击右上角「新建项目」，创建你的第一个课题。</p></div>`;
    return;
  }
  grid.innerHTML = state.projects.map(p => `
    <div class="account-card project-card" data-project="${p.id}">
      <div class="account-card__code">PROJECT <b>#${p.id}</b></div>
      <h4>${esc(p.name)}</h4>
      <p style="margin:0;color:var(--ink-700);font-size:.78rem;">${esc(p.note || "暂无描述")}</p>
      <div class="account-card__stats">
        <div><span>文件夹</span><strong>${p.folder_count || 0}</strong></div>
        <div><span>论文</span><strong>${p.paper_count || 0}</strong></div>
      </div>
    </div>`).join("");
  $$(".project-card", grid).forEach(card => card.addEventListener("click", () => openProject(parseInt(card.dataset.project))));
}

/* ============ 进入项目 ============ */
async function openProject(pid) {
  state.currentProjectId = pid;
  const p = state.projects.find(x => x.id === pid);
  state.currentProjectName = p ? p.name : "项目";
  state.currentFolderId = null;
  state.currentFolderPath = [];
  state.folderOpen = {};
  state.searchTerm = "";
  // 切项目时清空所有选择
  clearSelection();

  $("#project-page-title").textContent = state.currentProjectName;
  showView("project");
  // 高亮导航
  $$(".nav-project").forEach(b => b.classList.toggle("is-active", b.dataset.project == pid));
  await loadTree();
  await loadPapers();
}

async function loadTree() {
  const data = await req("GET", "/api/projects/tree?id=" + state.currentProjectId);
  state.folderTree = data.folders || [];
  renderTree();
}

function renderTree() {
  const el = $("#folder-tree");
  const renderNode = (node, depth) => {
    const isOpen = state.folderOpen[node.id] !== false; // 默认展开
    const hasChildren = node.children && node.children.length > 0;
    const isActive = state.currentFolderId === node.id;
    return `
      <div class="tree-folder" data-fid="${node.id}">
        <div class="tree-row ${isActive ? "is-active" : ""} ${isOpen && hasChildren ? "is-open" : ""}" data-fid="${node.id}">
          <label class="lib-sel lib-sel--tree" data-kind="folder" data-id="${node.id}">
            <input type="checkbox" class="lib-sel-chk" data-kind="folder" data-id="${node.id}">
          </label>
          <svg class="tree-chevron ${hasChildren ? "" : "is-leaf"}"><use href="#i-chevron"/></svg>
          <svg class="folder-ico"><use href="#i-folder"/></svg>
          <span class="tree-name">${esc(node.name)}</span>
          <span class="tree-count">${node.paper_count || 0}</span>
          <span class="tree-actions">
            <button data-act="add" title="新建子文件夹"><svg><use href="#i-plus"/></svg></button>
            <button data-act="move" title="移动到别的项目 / 文件夹（含全部子级与论文）"><svg><use href="#i-arrow"/></svg></button>
            <button data-act="del" title="删除文件夹"><svg><use href="#i-trash"/></svg></button>
          </span>
        </div>
        ${hasChildren && isOpen ? `<div class="tree-children">${node.children.map(c => renderNode(c, depth + 1)).join("")}</div>` : ""}
      </div>`;
  };
  el.innerHTML = state.folderTree.map(n => renderNode(n, 0)).join("");

  // 事件
  $$(".tree-row", el).forEach(row => {
    row.addEventListener("click", (e) => {
      // 点击在 checkbox 上 → 切换选择
      if (e.target.closest(".lib-sel")) {
        const fid = parseInt(row.dataset.fid);
        if (e.shiftKey) {
          rangeSelectInContainer(el, row, "folder");
        } else {
          if (state.selFolders.has(fid)) state.selFolders.delete(fid);
          else state.selFolders.add(fid);
          state.selectionAnchor.folder = fid;
        }
        updateSelectionUI();
        return;
      }
      const act = e.target.closest("[data-act]");
      const fid = parseInt(row.dataset.fid);
      if (act) {
        if (act.dataset.act === "add") openFolderModal(fid);
        else if (act.dataset.act === "move") openFolderMoveModal(fid);
        else if (act.dataset.act === "del") deleteFolder(fid);
        return;
      }
      // 多选模式下单击行 → 切换选择
      if (e.ctrlKey || e.metaKey) {
        if (state.selFolders.has(fid)) state.selFolders.delete(fid);
        else state.selFolders.add(fid);
        state.selectionAnchor.folder = fid;
        updateSelectionUI();
        return;
      }
      if (e.shiftKey) {
        rangeSelectInContainer(el, row, "folder");
        updateSelectionUI();
        return;
      }
      if (state.selFolders.size > 0) {
        if (state.selFolders.has(fid)) state.selFolders.delete(fid);
        else state.selFolders.add(fid);
        state.selectionAnchor.folder = fid;
        updateSelectionUI();
        return;
      }
      // 展开/收起 or 选中
      const node = findFolder(state.folderTree, fid);
      if (node && node.children && node.children.length) {
        state.folderOpen[fid] = !(state.folderOpen[fid] !== false);
        renderTree();
      }
      selectFolder(fid);
    });
  });
  updateSelectionUI();
}

function findFolder(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) { const r = findFolder(n.children, id); if (r) return r; }
  }
  return null;
}

function pathToFolder(nodes, id, trail = []) {
  for (const n of nodes) {
    const t = trail.concat([{ id: n.id, name: n.name }]);
    if (n.id === id) return t;
    if (n.children) { const r = pathToFolder(n.children, id, t); if (r) return r; }
  }
  return null;
}

async function selectFolder(fid) {
  state.currentFolderId = fid;
  state.currentFolderPath = pathToFolder(state.folderTree, fid) || [];
  // 切文件夹时清空论文选择（旧文件夹的论文在 UI 看不见，保留选择会让人困惑）
  state.selPapers.clear();
  renderTree();
  renderCrumbs();
  await loadPapers();
}

async function selectRoot() {
  state.currentFolderId = null;
  state.currentFolderPath = [];
  state.selPapers.clear();
  renderTree();
  renderCrumbs();
  await loadPapers();
}

function renderCrumbs() {
  const el = $("#crumbs");
  let html = `<span class="crumb" data-id="root">根目录</span>`;
  state.currentFolderPath.forEach((c, i) => {
    html += `<span class="crumb-sep">/</span><span class="crumb ${i === state.currentFolderPath.length - 1 ? "crumb-current" : ""}" data-id="${c.id}">${esc(c.name)}</span>`;
  });
  el.innerHTML = html;
  $$(".crumb", el).forEach(c => c.addEventListener("click", () => {
    const id = c.dataset.id;
    if (id === "root") selectRoot();
    else selectFolder(parseInt(id));
  }));
}

/* ============ 论文列表 ============ */
async function loadPapers() {
  let url = "/api/papers";
  if (state.currentFolderId) url += "?folder_id=" + state.currentFolderId;
  const data = await req("GET", url);
  state.papers = data.papers || [];
  renderPapers();
}

function renderPapers() {
  const el = $("#paper-list");
  let papers = state.papers;
  if (state.searchTerm) {
    const q = state.searchTerm.toLowerCase();
    papers = papers.filter(p => (p.title_en + " " + p.title_zh + " " + p.authors + " " + p.journal).toLowerCase().includes(q));
  }
  $("#papers-title").textContent = state.currentFolderPath.length
    ? state.currentFolderPath[state.currentFolderPath.length - 1].name
    : "全部论文（根目录）";

  if (!papers.length) {
    el.innerHTML = `<div class="empty-state"><p>${state.searchTerm ? "没有匹配的论文" : "这个文件夹还没有论文"}</p><small>${state.searchTerm ? "" : "点击右上角「导入论文」，拖入或选择 PDF"}</small></div>`;
    return;
  }

  el.innerHTML = papers.map(p => {
    const noteCount = (p.notes || []).length;
    const imgCount = (p.notes || []).reduce((s, n) => s + (n.images ? n.images.length : 0), 0);
    const title = p.title_en || p.title_zh || "（未命名论文）";
    return `
      <div class="paper-row" data-pid="${p.id}">
        <label class="lib-sel" data-kind="paper" data-id="${p.id}">
          <input type="checkbox" class="lib-sel-chk" data-kind="paper" data-id="${p.id}">
        </label>
        <div class="paper-row__main">
          <h4>${esc(title)}</h4>
          ${p.title_zh && p.title_en ? `<p class="paper-row__zh">${esc(p.title_zh)}</p>` : ""}
          <p class="paper-row__meta">
            ${p.journal ? `<span><svg><use href="#i-paper"/></svg>${esc(p.journal)}</span>` : ""}
            ${p.authors ? `<span><svg><use href="#i-edit"/></svg>${esc(p.authors.split(",")[0])}${p.authors.includes(",") ? " 等" : ""}</span>` : ""}
            ${p.publish_date ? `<span><svg><use href="#i-calendar"/></svg>${esc(p.publish_date)}</span>` : ""}
          </p>
        </div>
        ${noteCount ? `<span class="paper-row__notes">${noteCount} 思考${imgCount ? " · " + imgCount + " 图" : ""}</span>` : ""}
        <svg class="paper-row__arrow"><use href="#i-arrow"/></svg>
      </div>`;
  }).join("");

  $$(".paper-row", el).forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".lib-sel")) {
        const id = parseInt(row.dataset.pid);
        if (e.shiftKey) {
          rangeSelectInContainer(el, row, "paper");
        } else {
          if (state.selPapers.has(id)) state.selPapers.delete(id);
          else state.selPapers.add(id);
          state.selectionAnchor.paper = id;
        }
        updateSelectionUI();
        return;
      }
      handleSelectableClick(row, "paper", () => openPaperDrawer(parseInt(row.dataset.pid)), e);
    });
  });
  // 进入视图时同步勾选态
  updateSelectionUI();
}

/* ============ 论文详情抽屉 ============ */
async function openPaperDrawer(pid) {
  state.selNotes.clear(); // 打开新论文时清空思考多选
  const data = await req("GET", "/api/paper?id=" + pid);
  state._currentPaper = data.paper;
  renderPaperDrawer(data.paper);
  openDrawer();
}

function renderPaperDrawer(p) {
  const title = p.title_en || p.title_zh || "（未命名论文）";
  $("#drawer-title").textContent = title;
  $("#drawer-purpose").textContent = p.journal || "论文详情";
  $("#drawer-kicker").textContent = "PAPER / DETAIL";

  const notes = p.notes || [];
  const imgCount = notes.reduce((s, n) => s + (n.images ? n.images.length : 0), 0);

  let metaRows = `
    <tr><th>英文标题</th><td>${esc(p.title_en || "—")}</td></tr>
    <tr><th>中文标题</th><td>${esc(p.title_zh || "—")}</td></tr>
    <tr><th>期刊</th><td>${esc(p.journal || "—")}</td></tr>
    <tr><th>作者</th><td>${esc(p.authors || "—")}</td></tr>
    <tr><th>发表日期</th><td>${esc(p.publish_date || "—")}</td></tr>
    <tr><th>DOI</th><td>${esc(p.doi || "—")}</td></tr>`;
  if (p.url) {
    metaRows += `<tr><th>链接</th><td><a href="${esc(p.url)}" target="_blank" rel="noopener" style="color:var(--oxide-700);">${esc(p.url)}</a></td></tr>`;
  }
  if (p.local_path) {
    metaRows += `<tr><th>本地路径</th><td class="path-cell">${esc(p.local_path)}</td></tr>`;
  }

  const editBtnHtml = `<button class="scan-button scan-button--sm" id="edit-paper-btn" type="button" style="min-height:30px;padding:0 12px;font-size:.74rem;"><svg style="width:13px;height:13px;"><use href="#i-edit"/></svg>编辑论文</button>`;

  const openBtns = p.local_path ? `
    <div class="open-actions">
      <a class="article-open" id="open-pdf-btn" href="#"><svg><use href="#i-doc"/></svg><span>打开 PDF</span></a>
      <a class="article-open article-open--ghost" id="reveal-file-btn" href="#"><svg><use href="#i-folder-open"/></svg><span>打开所在文件夹</span></a>
      ${editBtnHtml}
    </div>` : `
    <div class="open-actions">
      ${editBtnHtml}
      <p style="color:var(--ink-700);font-size:.76rem;margin:0;align-self:center;">未设置本地路径。可在「编辑」中填写本地 PDF 的完整路径。</p>
    </div>`;

  $("#drawer-body").innerHTML = `
    <div class="drawer-stats">
      <div class="drawer-stat"><span>思考标注</span><strong>${notes.length}</strong></div>
      <div class="drawer-stat"><span>截图</span><strong>${imgCount}</strong></div>
      <div class="drawer-stat"><span>日期</span><strong style="font-size:.85rem;">${esc(p.publish_date || "—")}</strong></div>
    </div>

    <table class="meta-table">${metaRows}</table>
    ${openBtns}

    <div class="drawer-section-title"><span>我的思考</span></div>
    ${renderTopicRefsBar(p)}

    <div id="notes-list">
      ${renderNotesGrouped(notes)}
    </div>

    <div class="drawer-footer">
      <div class="note-bulk-bar" id="note-bulk-bar" ${state.selNotes.size ? "" : "hidden"}>
        <span id="note-bulk-count">已选中 ${state.selNotes.size} 条思考</span>
        <div>
          <button class="scan-button scan-button--ghost" id="note-bulk-sel-all" type="button"><svg><use href="#i-plus"/></svg><span>${notes.length && state.selNotes.size === notes.length ? "取消全选" : "全选"}</span></button>
          <button class="scan-button scan-button--ghost" id="note-bulk-del" type="button"><svg><use href="#i-trash"/></svg><span>删除选中</span></button>
          <button class="note-bulk-clear" id="note-bulk-clear" type="button">取消选择</button>
        </div>
      </div>
      <div class="drawer-footer__actions">
        <button class="scan-button" id="add-note-btn" type="button"><svg><use href="#i-plus"/></svg><span>新增思考</span></button>
        <button class="scan-button scan-button--ghost" id="compose-view-btn" type="button"><svg style="width:15px;height:15px;"><use href="#i-image"/></svg><span>View</span></button>
      </div>
    </div>`;

  // 绑定
  $("#drawer-close").onclick = closeDrawer;
  $("#edit-paper-btn").onclick = () => { closeDrawer(); openPaperModal(p); };
  if (p.local_path) {
    $("#open-pdf-btn").onclick = (e) => { e.preventDefault(); openLocal(p.local_path, false); };
    $("#reveal-file-btn").onclick = (e) => { e.preventDefault(); openLocal(p.local_path, true); };
  }

  $("#compose-view-btn").onclick = () => { closeDrawer(); openPaperView(p.id); };
  $("#add-note-btn").onclick = () => openNoteComposeEditor({ paperId: p.id });

  // 已有笔记的编辑 / 删除 / 归属
  $$("#notes-list .note-card__edit").forEach(btn => btn.addEventListener("click", () => {
    const nid = parseInt(btn.dataset.note);
    const note = (p.notes || []).find(n => n.id === nid);
    if (note) openNoteComposeEditor({ note });
  }));
  $$("#notes-list .note-card__del").forEach(btn => btn.addEventListener("click", () => deleteNote(parseInt(btn.dataset.note), p.id)));
  $$("#notes-list .note-card__assign").forEach(btn => btn.addEventListener("click", () => {
    const nid = parseInt(btn.dataset.note);
    const note = (p.notes || []).find(n => n.id === nid);
    if (note) openNoteAssignModal(note, () => openPaperDrawer(p.id));
  }));
  // 「被 N 个观点引用」的胶囊：点了直接跳到观点视图打开那个文件
  $$("#topic-refs-bar .topic-ref-chip").forEach(chip => {
    chip.addEventListener("click", () => jumpToTopicFile(parseInt(chip.dataset.file)));
  });

  // 思考多选删除
  $$("#notes-list .note-card__check input").forEach(cb => {
    cb.addEventListener("change", (e) => {
      const nid = parseInt(cb.dataset.note);
      if (e.target.checked) state.selNotes.add(nid);
      else state.selNotes.delete(nid);
      renderPaperDrawer(p);
    });
  });
  const bulkDel = $("#note-bulk-del");
  if (bulkDel) bulkDel.onclick = () => deleteSelectedNotes(p.id);
  const bulkClear = $("#note-bulk-clear");
  if (bulkClear) bulkClear.onclick = () => { state.selNotes.clear(); renderPaperDrawer(p); };
  const bulkSelAll = $("#note-bulk-sel-all");
  if (bulkSelAll) bulkSelAll.onclick = () => {
    if (state.selNotes.size === notes.length) state.selNotes.clear();
    else notes.forEach(n => state.selNotes.add(n.id));
    renderPaperDrawer(p);
  };
}

function flagBadge(n) {
  return n.flagged ? `<div class="note-flag" title="已标记：这条思考可能还没想透，待复查">!</div>` : "";
}

function renderNoteCard(n) {
  const checked = state.selNotes.has(n.id) ? "checked" : "";
  return `
    <div class="note-card ${checked ? "is-selected" : ""} ${n.flagged ? "is-flagged" : ""}" data-note="${n.id}">
      ${flagBadge(n)}
      <div class="note-card__head">
        <label class="note-card__check">
          <input type="checkbox" data-note="${n.id}" ${checked}>
          <span>${esc((n.created_at || "").replace("T", " ").slice(0, 16))}</span>
        </label>
        <div class="note-card__actions">
          <button class="note-card__assign${n.topic_file_id ? " is-set" : ""}" data-note="${n.id}" type="button" title="${n.topic_file_id ? "改归属 / 移到别的观点 / 清除归属" : "归属到某个观点"}"><svg style="width:12px;height:12px;"><use href="#i-flag"/></svg>归属</button>
          <button class="note-card__edit" data-note="${n.id}" type="button"><svg style="width:12px;height:12px;"><use href="#i-edit"/></svg>编辑</button>
          <button class="note-card__del" data-note="${n.id}" type="button"><svg style="width:12px;height:12px;"><use href="#i-trash"/></svg>删除</button>
        </div>
      </div>
      <div class="note-body">${renderNoteContent(n)}</div>
    </div>`;
}

// 把带 [[img:idx]] 占位符的文本渲染成 图文混排 HTML
function renderNoteContent(n) {
  const content = n.content || "";
  const images = n.images || [];
  const re = /\[\[(?:img:(\d+)|blk)\]\]/g;
  let html = "";
  let last = 0;
  let m;
  const used = new Set();
  const flushText = (txt) => {
    if (txt && txt.trim()) html += `<p class="note-text">${esc(txt).replace(/\n/g, "<br>")}</p>`;
  };
  while ((m = re.exec(content)) !== null) {
    flushText(content.slice(last, m.index));
    // [[blk]] 是纯文本块边界：前后文本各自成段；[[img:N]] 渲染内联图
    if (m[1] !== undefined) {
      const idx = parseInt(m[1]);
      const img = images[idx];
      if (img) {
        html += `<div class="note-img-inline"><img src="/assets/${encodeURI(img.rel_path)}" alt="截图" loading="lazy"></div>`;
        used.add(idx);
      }
    }
    last = m.index + m[0].length;
  }
  flushText(content.slice(last));
  // 兼容旧数据：未被占位符引用的图片，追加显示在文字后
  images.forEach((img, idx) => {
    if (!used.has(idx)) html += `<div class="note-img-inline"><img src="/assets/${encodeURI(img.rel_path)}" alt="截图" loading="lazy"></div>`;
  });
  return html || `<p class="note-text" style="color:var(--ink-500);">（空）</p>`;
}

// 把编辑区内容序列化为 带占位符的文本 + 图片数组
function serializeCompose(editor) {
  let content = "";
  const images = [];
  const idxMap = {};
  const walk = (node) => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { content += ch.textContent; }
      else if (ch.nodeName === "IMG") {
        const oidx = parseInt(ch.dataset.idx);
        if (!(oidx in idxMap) && state.composeImages[oidx]) {
          idxMap[oidx] = images.length;
          images.push(state.composeImages[oidx]);
        }
        if (oidx in idxMap) content += `[[img:${idxMap[oidx]}]]`;
      }
      else if (ch.nodeName === "BR") { content += "\n"; }
      // Chrome 的 contenteditable 按 Enter 会产生 <div>，裸文本节点后紧跟 <div>/<p> 时
      // 必须先补一个换行，否则第一行和第二行会被 walk 挤到一起（换行丢失的根因）
      else if (ch.nodeName === "DIV" || ch.nodeName === "P") { if (content && !content.endsWith("\n")) content += "\n"; walk(ch); content += "\n"; }
      else { walk(ch); }
    });
  };
  walk(editor);
  return { content, images };
}

// 粘贴的图片插入编辑区光标处
function insertComposeImage(blob, editor) {
  blobToBase64(blob).then(b64 => {
    const ext = blob.type.includes("png") ? "png" : "jpg";
    const idx = state.composeImages.length;
    state.composeImages.push({ data: b64, ext });
    const img = document.createElement("img");
    img.src = "data:image/" + ext + ";base64," + b64;
    img.dataset.idx = idx;
    img.className = "compose-img";
    const sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(img);
    }
    editor.focus();
  });
}

async function addNote(paperId, editor) {
  const { content, images } = serializeCompose(editor);
  const textOnly = content.replace(/\[\[img:\d+\]\]/g, "").trim();
  if (!textOnly && images.length === 0) {
    toast("先写点内容或加张图");
    return;
  }
  try {
    const nd = await req("POST", "/api/notes", { paper_id: paperId, content });
    const nid = nd.id;
    for (const img of images) {
      await req("POST", "/api/notes/images", { note_id: nid, data: img.data, ext: img.ext });
    }
    // 撤销新增 = 软删这条思考（进历史版本）；重做 = 从历史版本恢复
    pushUndo("新增思考",
      async () => { await req("DELETE", "/api/notes?id=" + nid); },
      async () => { await restoreNotesByIds([nid]); });
    toast("已保存思考");
    state.composeImages = [];
    state.composeDrafts.delete(paperId);
    await refreshPaper(paperId);
  } catch (e) { toast(e.message, true); }
}

async function refreshPaper(pid) {
  const data = await req("GET", "/api/paper?id=" + pid);
  state._currentPaper = data.paper;
  renderPaperDrawer(data.paper);
  await loadPapers();
}

async function deleteNote(nid, paperId) {
  if (!confirm("删除这条思考？删除后可在历史版本保留 7 天，提示条里点「撤销」可立即找回。")) return;
  await req("DELETE", "/api/notes?id=" + nid);
  pushUndo("删除思考",
    async () => { await restoreNotesByIds([nid]); },
    async () => { await req("DELETE", "/api/notes?id=" + nid); });
  toastAction("已删除 1 条思考", "撤销", () => undoDeleteNotes([nid], () => refreshPaper(paperId)));
  await refreshPaper(paperId);
}

async function deleteSelectedNotes(paperId) {
  const ids = Array.from(state.selNotes);
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 条思考？删除后可在历史版本保留 7 天，提示条里点「撤销」可立即找回。`)) return;
  await req("DELETE", "/api/notes?ids=" + ids.join(","));
  pushUndo("删除 " + ids.length + " 条思考",
    async () => { await restoreNotesByIds(ids); },
    async () => { await req("DELETE", "/api/notes?ids=" + ids.join(",")); });
  state.selNotes.clear();
  toastAction(`已删除 ${ids.length} 条思考`, "撤销", () => undoDeleteNotes(ids, () => refreshPaper(paperId)));
  await refreshPaper(paperId);
}

async function deleteImage(iid, paperId) {
  await req("DELETE", "/api/notes/images?id=" + iid);
  toast("已删除图片");
  await refreshPaper(paperId);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function openLocal(path, reveal) {
  try {
    const r = await req("POST", "/api/open", { path, reveal });
    if (r.ok) toast(reveal ? "已在资源管理器中定位" : "已打开文件");
    else toast(r.error, true);
  } catch (e) { toast(e.message, true); }
}

/* ============ 抽屉开关 ============ */
function openDrawer() {
  $("#drawer-backdrop").hidden = false;
  $("#detail-drawer").setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    $("#drawer-backdrop").classList.add("is-open");
    $("#detail-drawer").classList.add("is-open");
  });
}
function closeDrawer() {
  // 关闭前暂存未保存的思考草稿，避免误点外部导致内容丢失
  const editor = $("#note-editor");
  if (editor && state._currentPaper) {
    const html = editor.innerHTML.trim();
    const hasContent = html && html !== "<br>" && html !== "<div><br></div>";
    if (hasContent || state.composeImages.length) {
      state.composeDrafts.set(state._currentPaper.id, {
        html: editor.innerHTML,
        images: state.composeImages.slice(),
      });
    } else {
      state.composeDrafts.delete(state._currentPaper.id);
    }
  }

  $("#drawer-backdrop").classList.remove("is-open");
  $("#detail-drawer").classList.remove("is-open");
  $("#detail-drawer").setAttribute("aria-hidden", "true");
  setTimeout(() => { $("#drawer-backdrop").hidden = true; }, 320);
}
$("#drawer-backdrop").addEventListener("click", closeDrawer);

/* ============ 论文思考全屏浏览（VIEW） ============ */
async function openPaperView(pid) {
  const data = await req("GET", "/api/paper?id=" + pid);
  const paper = data.paper;
  state._viewPaper = paper;
  state._viewPaperReturnTo = state.currentView || "project";
  state.selViewNotes.clear();
  renderPaperView(paper);
  showView("paper-view");
}

function closePaperView() {
  exitArrangeMode(false);
  const paper = state._viewPaper;
  const back = state._viewPaperReturnTo || "project";
  state._viewPaper = null;
  state._viewPaperReturnTo = null;
  state.selViewNotes.clear();
  // 退出观察后回到该论文的抽屉状态，而不是退回到无选中的初始界面
  if (paper && paper.id) {
    showView(back);
    openPaperDrawer(paper.id);
  } else {
    showView(back);
  }
}

function renderPaperView(p) {
  exitArrangeMode(false); // 重渲染前清理排版模式（含自动滚动定时器与全局 dragover 监听）
  const notes = p.notes || [];
  const imgCount = notes.reduce((s, n) => s + (n.images ? n.images.length : 0), 0);

  $("#paper-view-subtitle").textContent = notes.length
    ? `共 ${notes.length} 条思考，${imgCount} 张截图。滚动查看完整回顾。`
    : "这篇论文还没有思考记录。点击「新增思考」写下第一条。";

  $("#pv-stats").innerHTML = `
    <div><span>思考标注</span><strong>${notes.length}</strong></div>
    <div><span>截图</span><strong>${imgCount}</strong></div>
    <div><span>发表日期</span><strong>${esc(p.publish_date || "—")}</strong></div>`;

  const list = $("#pv-list");
  if (!notes.length) {
    list.innerHTML = `
      <div class="pv-empty">
        <svg><use href="#i-image"/></svg>
        <h4>还没有思考</h4>
        <p>点击上方「新增思考」写下第一条，或回到抽屉添加。</p>
      </div>`;
  } else {
    // 每张卡片左上角：归属观点大胶囊，醒目、点击跳到观点视图打开该观点
    // （右上角的「归属」按钮保持原有交互不动）
    list.innerHTML = notes.map((n, idx) => {
      const tp = (n.topic_path || "").trim();
      const tag = tp
        ? `<button class="assign-chip" data-tfid="${n.topic_file_id}" type="button" title="点击跳转到观点视图打开该观点"><svg><use href="#i-flag"/></svg><span>${esc(tp)}</span></button>`
        : `<span class="assign-chip is-none" title="还没归属到任何观点"><svg><use href="#i-flag"/></svg><span>未归属</span></span>`;
      return renderViewNoteCard(n, idx + 1).replace('<div class="pv-card__head">', tag + '<div class="pv-card__head">');
    }).join("");
  }

  // VIEW 页批量操作条
  const bulkBar = $("#pv-bulk-bar");
  const bulkCount = $("#pv-bulk-count");
  if (bulkBar) {
    bulkBar.hidden = state.selViewNotes.size === 0;
    if (bulkCount) bulkCount.textContent = `已选中 ${state.selViewNotes.size} 条思考`;
  }
  const bulkSelAll = $("#pv-bulk-sel-all");
  if (bulkSelAll) {
    bulkSelAll.innerHTML = `<svg><use href="#i-plus"/></svg><span>${notes.length && state.selViewNotes.size === notes.length ? "取消全选" : "全选"}</span>`;
    bulkSelAll.onclick = () => {
      if (state.selViewNotes.size === notes.length) state.selViewNotes.clear();
      else notes.forEach(n => state.selViewNotes.add(n.id));
      renderPaperView(p);
    };
  }
  const bulkDel = $("#pv-bulk-del");
  if (bulkDel) bulkDel.onclick = () => deleteSelectedViewNotes(p.id);
  const bulkClear = $("#pv-bulk-clear");
  if (bulkClear) bulkClear.onclick = () => { state.selViewNotes.clear(); renderPaperView(p); };

  // 归属胶囊：点击跳到观点视图打开该观点
  $$("#pv-list .assign-chip[data-tfid]").forEach(chip => {
    chip.addEventListener("click", () => jumpToTopicFile(parseInt(chip.dataset.tfid)));
  });

  // 绑定每条思考的 新增 / 删除 / 编辑 / 全屏 按钮
  $$(".pv-card__action[data-action='add']").forEach(btn => {
    btn.onclick = () => openNoteComposeEditor({ paperId: p.id });
  });
  $$(".pv-card__action[data-action='delete']").forEach(btn => {
    btn.onclick = () => {
      const nid = parseInt(btn.closest(".pv-card").dataset.noteId);
      const note = (state._viewPaper?.notes || []).find(n => n.id === nid);
      if (note) deleteViewNote(note, p.id);
    };
  });
  $$(".pv-card__action[data-action='edit']").forEach(btn => {
    btn.onclick = () => {
      const nid = parseInt(btn.closest(".pv-card").dataset.noteId);
      const note = (state._viewPaper?.notes || []).find(n => n.id === nid);
      if (note) openNoteComposeEditor({ note });
    };
  });
  $$(".pv-card__action[data-action='fullscreen']").forEach(btn => {
    btn.onclick = () => {
      const nid = parseInt(btn.closest(".pv-card").dataset.noteId);
      const note = (state._viewPaper?.notes || []).find(n => n.id === nid);
      if (note) openNoteFullscreen(note);
    };
  });
  $$(".pv-card__action[data-action='arrange']").forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest(".pv-card");
      const nid = parseInt(card.dataset.noteId);
      const note = (state._viewPaper?.notes || []).find(n => n.id === nid);
      if (!note) return;
      if (state.arrange && state.arrange.noteId === nid) exitArrangeMode();
      else enterArrangeMode(card, note);
    };
  });
  $$(".pv-card__action[data-action='assign']").forEach(btn => {
    btn.onclick = () => {
      const nid = parseInt(btn.closest(".pv-card").dataset.noteId);
      const note = (state._viewPaper?.notes || []).find(n => n.id === nid);
      if (note) openNoteAssignModal(note, () => openPaperView(p.id));
    };
  });

  // 多选复选框
  $$(".pv-card__check input").forEach(cb => {
    cb.addEventListener("change", (e) => {
      const nid = parseInt(cb.dataset.note);
      if (e.target.checked) state.selViewNotes.add(nid);
      else state.selViewNotes.delete(nid);
      renderPaperView(p);
    });
  });

  layoutViewImages(list);

  $("#pv-back-btn").onclick = closePaperView;
}

function layoutViewImages(root) {
  if (!root) return;
  root.querySelectorAll(".pv-block--media img").forEach(img => {
    const classify = () => {
      const ratio = img.naturalWidth / (img.naturalHeight || 1);
      const block = img.closest(".pv-block--media");
      if (!block) return;
      // 只有用户未手动指定列（data-auto）时才按宽高比自动调整
      if (block.dataset.auto === "1") {
        block.classList.toggle("pv-block--col-full", ratio >= 1);
        block.classList.toggle("pv-block--col-2", ratio < 1);
        block.classList.remove(ratio >= 1 ? "pv-block--col-2" : "pv-block--col-full");
      }
    };
    if (img.complete && img.naturalHeight) classify();
    else img.addEventListener("load", classify, { once: true });
  });
}

async function deleteViewNote(note, paperId) {
  if (!confirm("删除这条思考？删除后可在历史版本中保留 7 天，提示条里点「撤销」可立即找回。")) return;
  await req("DELETE", "/api/notes?id=" + note.id);
  pushUndo("删除思考",
    async () => { await restoreNotesByIds([note.id]); },
    async () => { await req("DELETE", "/api/notes?id=" + note.id); });
  toastAction("已删除 1 条思考", "撤销", () => undoDeleteNotes([note.id], () => openPaperView(paperId)));
  await openPaperView(paperId);
}

/* ============ 大屏直接拖拽排版（插入 + 对换） ============ */
// 进入排版模式：把当前卡片的块按 DOM 顺序与已生效的列（含宽高比自动判定的列）固化下来。
// 两种操作：
//  ① 拖拽插入：拖到目标块的上半部/下半部，插入到它前面/后面（列属性跟着块走），
//     适合把全宽块插到两行中间这类「插缝」需求；
//  ② 点选对换：点击选中一块（铜橙框），滚动到任意位置后按住 Ctrl 点另一块，两块对换槽位
//    （列属性留在槽位上，内容互换），适合跨长距离交换。
// 每次操作都立即保存 layout。拖拽接近视口边缘时页面自动滚动。
function enterArrangeMode(card, note) {
  if (state.arrange) exitArrangeMode(false);
  const body = card.querySelector(".pv-card__body");
  const blocks = $$(".pv-block", body).map((el, i) => ({
    key: el.dataset.key,
    col: el.classList.contains("pv-block--col-full") ? "full" : (el.classList.contains("pv-block--col-1") ? 1 : 2),
    order: i,
  }));
  if (blocks.length < 2) { toast("这条思考只有 1 个块，无需排版"); return; }
  state.arrange = { noteId: note.id, note, blocks, dirty: false, selectedKey: null };
  card.classList.add("is-arranging");
  const btn = card.querySelector(".pv-card__action[data-action='arrange'] span");
  if (btn) btn.textContent = "完成";
  bindArrangeDrag(card);
  // 拖拽接近视口边缘时自动滚动（dragover 只间歇触发，用定时器做平滑滚动）
  state._arrangeDragY = null;
  state._arrangeScrollTimer = setInterval(() => {
    const y = state._arrangeDragY;
    if (y == null) return;
    const margin = 90, speed = 18;
    if (y < margin) window.scrollBy(0, -speed);
    else if (y > window.innerHeight - margin) window.scrollBy(0, speed);
  }, 50);
  state._arrangeDragoverFn = (e) => { state._arrangeDragY = e.clientY; };
  document.addEventListener("dragover", state._arrangeDragoverFn);
  toast("排版模式：拖到某块上/下半部即插入到它前/后；点选一块后 Ctrl+点另一块可对换。点「完成」退出");
}

function exitArrangeMode(notify = true) {
  const a = state.arrange;
  if (!a) return;
  state.arrange = null;
  if (state._arrangeScrollTimer) { clearInterval(state._arrangeScrollTimer); state._arrangeScrollTimer = null; }
  if (state._arrangeDragoverFn) { document.removeEventListener("dragover", state._arrangeDragoverFn); state._arrangeDragoverFn = null; }
  state._arrangeDragY = null;
  // 同一条思考可能在观点视图和论文 View 各渲染一份（隐藏视图的 DOM 仍在），
  // 必须把所有同 id 卡片都复位，否则只复位了文档顺序靠前的那张（排版按钮卡在「完成」的根因）
  $$(`.pv-card[data-note-id="${a.noteId}"]`).forEach(card => {
    card.classList.remove("is-arranging");
    $$(".pv-block", card).forEach(el => {
      el.draggable = false;
      el.classList.remove("is-dragging", "is-insert-before", "is-insert-after", "is-selected");
    });
    const btn = card.querySelector(".pv-card__action[data-action='arrange'] span");
    if (btn) btn.textContent = "排版";
  });
  if (notify && a.dirty) toast("排版已保存");
}

function arrangeLayout() {
  return { blocks: state.arrange.blocks.map(b => ({ key: b.key, col: b.col, order: b.order })) };
}

function bindArrangeDrag(card) {
  $$(".pv-block", card).forEach(el => {
    el.draggable = true;
    // 阻止图片自身的原生拖拽，让整块作为拖拽源
    el.querySelectorAll("img").forEach(im => { im.draggable = false; });
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", el.dataset.key);
      el.classList.add("is-dragging");
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("is-dragging");
      state._arrangeDragY = null;
      $$(".pv-block", card).forEach(x => x.classList.remove("is-insert-before", "is-insert-after"));
    });
    el.addEventListener("dragover", (e) => {
      const dragging = card.querySelector(".pv-block.is-dragging");
      if (!dragging || dragging === el) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // 上半部 = 插到它前面，下半部 = 插到它后面
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      $$(".pv-block", card).forEach(x => x.classList.remove("is-insert-before", "is-insert-after"));
      el.classList.add(before ? "is-insert-before" : "is-insert-after");
    });
    el.addEventListener("dragleave", () => el.classList.remove("is-insert-before", "is-insert-after"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const before = el.classList.contains("is-insert-before");
      el.classList.remove("is-insert-before", "is-insert-after");
      const key = e.dataTransfer.getData("text/plain");
      if (!key || key === el.dataset.key || !state.arrange) return;
      insertArrangeBlock(key, el.dataset.key, before, card);
    });
    // 点选 / Ctrl+点选对换
    el.addEventListener("click", (e) => {
      const a = state.arrange;
      if (!a) return;
      if ((e.ctrlKey || e.metaKey) && a.selectedKey && a.selectedKey !== el.dataset.key) {
        const fromKey = a.selectedKey;
        a.selectedKey = null;
        $$(".pv-block.is-selected", card).forEach(x => x.classList.remove("is-selected"));
        if (confirm("将选中的块与这个块对换位置？")) swapArrangeBlocks(fromKey, el.dataset.key, card);
        return;
      }
      // 普通点击（或 Ctrl+点击但尚未有选中块）：切换选中
      if (a.selectedKey === el.dataset.key) {
        a.selectedKey = null;
        el.classList.remove("is-selected");
      } else {
        a.selectedKey = el.dataset.key;
        $$(".pv-block.is-selected", card).forEach(x => x.classList.remove("is-selected"));
        el.classList.add("is-selected");
        toast("已选中一块。滚动找到目标块后，按住 Ctrl 点击它即可对换；再点一下取消选中");
      }
    });
  });
}

// 模拟 CSS grid（2 列 + dense 回填）的实际放置，返回视觉行数组 [{c1, c2}]。
// 注意：视觉行序 ≠ 数据顺序（dense 会让后序列的块回填到前面的空位），
// 插入锚点必须按视觉行计算，否则会出现「拖到右上角下沿没反应」的错觉。
function computeVisualRows(blocks) {
  const rows = [];
  const newRow = () => ({ c1: null, c2: null });
  blocks.forEach(b => {
    if (b.col === "full") {
      let row = rows.find(r => !r.c1 && !r.c2); // full 需要整行空
      if (!row) { row = newRow(); rows.push(row); }
      row.c1 = row.c2 = b;
    } else if (b.col === 1) {
      let row = rows.find(r => !r.c1);
      if (!row) { row = newRow(); rows.push(row); }
      row.c1 = b;
    } else {
      let row = rows.find(r => !r.c2);
      if (!row) { row = newRow(); rows.push(row); }
      row.c2 = b;
    }
  });
  return rows;
}

// 一行内按数据顺序最早的成员（插入锚点用）
function visualRowAnchor(row) {
  const members = [];
  if (row.c1) members.push(row.c1);
  if (row.c2 && row.c2 !== row.c1) members.push(row.c2);
  members.sort((x, y) => x.order - y.order);
  return members[0] || null;
}

// 拖拽插入：把 dragKey 块移到 targetKey 块所在「视觉行」的前/后，列属性跟着块走
async function insertArrangeBlock(dragKey, targetKey, before, card) {
  const a = state.arrange;
  if (!a) return;
  const blocks = a.blocks;
  const from = blocks.findIndex(b => b.key === dragKey);
  if (from < 0) return;
  // 1. 模拟当前视觉行，找目标块在第几行
  const rows = computeVisualRows(blocks);
  let targetRowIdx = -1;
  rows.forEach((r, i) => {
    if ((r.c1 && r.c1.key === targetKey) || (r.c2 && r.c2.key === targetKey)) targetRowIdx = i;
  });
  if (targetRowIdx < 0) return;
  // 2. 锚点：before → 目标行最早成员；after → 下一行最早成员（无则末尾）
  let anchorKey = null;
  if (before) {
    const anchor = visualRowAnchor(rows[targetRowIdx]);
    anchorKey = anchor ? anchor.key : null;
  } else {
    const next = rows[targetRowIdx + 1];
    if (next) {
      const anchor = visualRowAnchor(next);
      anchorKey = anchor ? anchor.key : null;
    }
  }
  // 3. 重排
  const [moved] = blocks.splice(from, 1);
  if (anchorKey == null) blocks.push(moved);
  else {
    const idx = blocks.findIndex(b => b.key === anchorKey);
    if (idx < 0) blocks.push(moved);
    else blocks.splice(idx, 0, moved);
  }
  blocks.forEach((b, i) => { b.order = i; });
  a.dirty = true;
  await applyArrangeAndSave(card);
}

// 点选对换：两块互换槽位（列与顺序互换，内容换位）
async function swapArrangeBlocks(keyA, keyB, card) {
  const a = state.arrange;
  if (!a) return;
  const ba = a.blocks.find(b => b.key === keyA);
  const bb = a.blocks.find(b => b.key === keyB);
  if (!ba || !bb) return;
  [ba.col, bb.col] = [bb.col, ba.col];
  [ba.order, bb.order] = [bb.order, ba.order];
  a.blocks.sort((x, y) => x.order - y.order);
  a.dirty = true;
  await applyArrangeAndSave(card);
}

// 重渲染卡片 body + 重新绑定拖拽 + 保存 layout
async function applyArrangeAndSave(card) {
  const a = state.arrange;
  if (!a) return;
  // 优先用进入排版模式时存下的 note 引用（观点视图里 state._viewPaper 是别的论文，不能靠它找）
  const note = a.note || (state._viewPaper?.notes || []).find(n => n.id === a.noteId);
  if (!note) return;
  const layout = arrangeLayout();
  const body = card.querySelector(".pv-card__body");
  body.innerHTML = renderViewNoteBlocks({ ...note, layout });
  layoutViewImages(body);
  bindArrangeDrag(card);
  try {
    await req("PUT", "/api/notes/layout", { id: note.id, layout });
    const oldLayout = note.layout;
    note.layout = layout; // 同步内存，后续重渲染保持新排版
    // 撤销排版 = 存回旧 layout；重做 = 再存新 layout
    pushUndo("调整排版",
      async () => { await req("PUT", "/api/notes/layout", { id: note.id, layout: oldLayout }); note.layout = oldLayout; },
      async () => { await req("PUT", "/api/notes/layout", { id: note.id, layout }); note.layout = layout; });
  } catch (err) {
    toast("排版保存失败：" + (err && err.message || err));
  }
}

async function deleteSelectedViewNotes(paperId) {
  const ids = Array.from(state.selViewNotes);
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 条思考？删除后可在历史版本保留 7 天，提示条里点「撤销」可立即找回。`)) return;
  await req("DELETE", "/api/notes?ids=" + ids.join(","));
  pushUndo("删除 " + ids.length + " 条思考",
    async () => { await restoreNotesByIds(ids); },
    async () => { await req("DELETE", "/api/notes?ids=" + ids.join(",")); });
  state.selViewNotes.clear();
  toastAction(`已删除 ${ids.length} 条思考`, "撤销", () => undoDeleteNotes(ids, () => openPaperView(paperId)));
  await openPaperView(paperId);
}

function openAddNoteModal(paperId) {
  openNoteComposeEditor({ paperId });
}

function serializeAddNoteEditor(editor) {
  let content = "";
  const images = [];
  const idxMap = {};
  const walk = (node) => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { content += ch.textContent; }
      else if (ch.nodeName === "IMG") {
        const oidx = parseInt(ch.dataset.idx);
        if (!(oidx in idxMap) && state.addNoteImages[oidx]) {
          idxMap[oidx] = images.length;
          images.push(state.addNoteImages[oidx]);
        }
        if (oidx in idxMap) content += `[[img:${idxMap[oidx]}]]`;
      }
      else if (ch.nodeName === "BR") { content += "\n"; }
      // Chrome 的 contenteditable 按 Enter 会产生 <div>，裸文本节点后紧跟 <div>/<p> 时
      // 必须先补一个换行，否则第一行和第二行会被 walk 挤到一起（换行丢失的根因）
      else if (ch.nodeName === "DIV" || ch.nodeName === "P") { if (content && !content.endsWith("\n")) content += "\n"; walk(ch); content += "\n"; }
      else { walk(ch); }
    });
  };
  walk(editor);
  return { content, images };
}

function insertAddNoteImage(blob, editor) {
  blobToBase64(blob).then(b64 => {
    const ext = blob.type.includes("png") ? "png" : "jpg";
    const idx = state.addNoteImages.length;
    state.addNoteImages.push({ data: b64, ext });
    const img = document.createElement("img");
    img.src = "data:image/" + ext + ";base64," + b64;
    img.dataset.idx = idx;
    img.className = "compose-img";
    const sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(img);
    }
    editor.focus();
  });
}

const FULLSCREEN_SCALE_CLASSES = ["is-small", "is-default", "is-large"];
let fullscreenScaleIndex = 1;

function applyFullscreenScale() {
  const content = $("#note-fullscreen-content");
  if (!content) return;
  FULLSCREEN_SCALE_CLASSES.forEach((c, i) => content.classList.toggle(c, i === fullscreenScaleIndex));
}

function openNoteFullscreen(n, idx) {
  const overlay = $("#note-fullscreen");
  const content = $("#note-fullscreen-content");
  fullscreenScaleIndex = 1; // 默认标准大小
  // idx：显式传序号（观点视图里 state._viewPaper 是别的论文，不能用 indexOf 算）
  const seq = idx != null ? idx : (state._viewPaper?.notes?.indexOf(n) + 1 || "");
  content.innerHTML = `
    ${flagBadge(n)}
    <div class="pv-card__head" style="border-color:rgba(255,255,255,.12);">
      <span class="pv-card__time" style="color:rgba(255,255,255,.7);">${esc((n.created_at || "").replace("T", " ").slice(0, 16))}</span>
      <span class="pv-card__index" style="color:rgba(255,255,255,.55);">#${esc(String(seq))}</span>
    </div>
    <div class="note-fullscreen__body">${renderViewNoteBlocks(n)}</div>`;
  applyFullscreenScale();
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  $("#note-fullscreen-close").onclick = closeNoteFullscreen;
  $("#note-fullscreen-zoomin").onclick = () => {
    if (fullscreenScaleIndex < FULLSCREEN_SCALE_CLASSES.length - 1) { fullscreenScaleIndex++; applyFullscreenScale(); }
  };
  $("#note-fullscreen-zoomout").onclick = () => {
    if (fullscreenScaleIndex > 0) { fullscreenScaleIndex--; applyFullscreenScale(); }
  };
}

function closeNoteFullscreen() {
  $("#note-fullscreen").hidden = true;
  $("#note-fullscreen-content").innerHTML = "";
  document.body.style.overflow = "";
}

function renderViewNoteCard(n, idx) {
  const time = esc((n.created_at || "").replace("T", " ").slice(0, 16));
  const checked = state.selViewNotes.has(n.id) ? "checked" : "";
  return `
    <article class="pv-card ${checked ? "is-selected" : ""} ${n.flagged ? "is-flagged" : ""}" data-note-id="${n.id}">
      ${flagBadge(n)}
      <div class="pv-card__head">
        <label class="pv-card__check">
          <input type="checkbox" data-note="${n.id}" ${checked}>
          <span class="pv-card__time">${time}</span>
        </label>
        <div class="pv-card__actions">
          <button class="pv-card__action" data-action="add" type="button" title="新增思考"><svg><use href="#i-plus"/></svg><span>新增</span></button>
          <button class="pv-card__action pv-card__action--danger" data-action="delete" type="button" title="删除思考"><svg><use href="#i-trash"/></svg><span>删除</span></button>
          <button class="pv-card__action" data-action="edit" type="button" title="编辑思考"><svg><use href="#i-edit"/></svg><span>编辑</span></button>
          <button class="pv-card__action" data-action="assign" type="button" title="加入 / 移动到某个观点，或清除归属变游民"><svg><use href="#i-flag"/></svg><span>归属</span></button>
          <button class="pv-card__action" data-action="arrange" type="button" title="拖拽排版：按住块拖到另一块上对换位置"><svg><use href="#i-layout"/></svg><span>排版</span></button>
          <button class="pv-card__action" data-action="fullscreen" type="button" title="全屏查看"><svg><use href="#i-image"/></svg><span>全屏</span></button>
          <span class="pv-card__index">${idx != null ? "#" + idx : ""}</span>
        </div>
      </div>
      <div class="pv-card__body">
        ${renderViewNoteBlocks(n)}
      </div>
    </article>`;
}

// 从 content + images 生成 blocks 数组（text / image）
function buildNoteBlocks(n) {
  const content = n.content || "";
  const images = n.images || [];
  const re = /\[\[(?:img:(\d+)|blk)\]\]/g;
  const blocks = [];
  let last = 0, m;
  const used = new Set();
  let textIndex = 0;

  const pushText = (txt) => {
    const t = txt.trim();
    if (t) blocks.push({ type: "text", key: `text_${textIndex++}`, text: t, index: textIndex - 1 });
  };

  while ((m = re.exec(content)) !== null) {
    pushText(content.slice(last, m.index));
    // [[blk]]：排版编辑器存的纯文本块边界——没有它，多个文本块会被合并成一个块，
    // layout 的 col/order 全部对不上（三个栏挤成一个窄竖条的根因）
    if (m[1] !== undefined) {
      const idx = parseInt(m[1]);
      const img = images[idx];
      if (img) {
        blocks.push({ type: "image", key: `img_${img.id}`, image: img, image_id: img.id });
        used.add(idx);
      }
    }
    last = m.index + m[0].length;
  }
  pushText(content.slice(last));

  // 兼容旧数据：未被占位符引用的图片追加在最后
  images.forEach((img, idx) => {
    if (!used.has(idx)) blocks.push({ type: "image", key: `img_${img.id}`, image: img, image_id: img.id });
  });

  return blocks;
}

// 未保存过排版时的默认列：文字在左栏，图片默认在右栏。
function defaultBlockCol(block) {
  return block.type === "text" ? 1 : 2;
}

// 合并用户保存的 layout 与默认布局。
// 兼容两种格式：① 旧格式带 key，按 key 匹配；② 新格式只存 {col, order}，按 order 位置套用（不依赖 key）。
function applyLayout(blocks, layout) {
  const saved = (layout && layout.blocks) || [];
  const byKey = saved.length && saved[0] && saved[0].key != null;
  if (byKey) {
    const map = new Map(saved.map(b => [b.key, b]));
    return blocks.map((b, i) => {
      const s = map.get(b.key);
      return {
        ...b,
        col: s && s.col != null ? s.col : defaultBlockCol(b),
        order: s && s.order != null ? s.order : i,
      };
    }).sort((a, b) => a.order - b.order);
  }
  const ordered = saved.slice().sort((a, b) => a.order - b.order);
  return blocks.map((b, i) => {
    const s = ordered[i];
    return { ...b, col: s && s.col != null ? s.col : defaultBlockCol(b) };
  });
}

// 把一条思考按内容顺序拆成「文字块 / 图片块」，在 2 列网格里依次排列，
// 保留原文中「先文字 → 再图片 → 再文字」的逻辑关系。
// 如果用户保存过 layout，按 layout 中指定的列(1左/2右/full全宽)与顺序渲染。
function renderViewNoteBlocks(n) {
  const blocks = applyLayout(buildNoteBlocks(n), n.layout || {});
  if (!blocks.length) return `<div class="pv-block pv-block--text" style="color:var(--ink-500);">（空）</div>`;

  return blocks.map(b => {
    const col = b.col == null ? defaultBlockCol(b) : b.col;
    const colClass = col === 1 ? "pv-block--col-1" : (col === 2 ? "pv-block--col-2" : "pv-block--col-full");
    const autoAttr = b.col == null ? ' data-auto="1"' : "";
    if (b.type === "text") {
      return `<div class="pv-block pv-block--text ${colClass}" data-key="${b.key}"${autoAttr}><span class="pv-block__label">文字</span><div class="pv-block__content">${esc(b.text).replace(/\n/g, "<br>")}</div></div>`;
    }
    return `<div class="pv-block pv-block--media ${colClass}" data-key="${b.key}"${autoAttr}><span class="pv-block__label">截图</span><img src="/assets/${encodeURI(b.image.rel_path)}" alt="截图" loading="lazy"></div>`;
  }).join("");
}

/* ============ 排版编辑器：可排序的功能栏（左/右/全宽） ============ */
// 把一条思考按已保存 layout 还原成「栏（section）」列表；连续同列的块归为同一栏。
function buildSectionsFromNote(note) {
  const blocks = applyLayout(buildNoteBlocks(note), note.layout || {});
  const sections = [];
  let counter = 0;
  let cur = null;
  blocks.forEach(b => {
    if (!cur || String(cur.col) !== String(b.col)) {
      cur = { id: "s" + (++counter), col: b.col, items: [] };
      sections.push(cur);
    }
    cur.items.push(b);
  });
  return { sections, nextId: counter };
}

async function openNoteComposeEditor(opts) {
  const { paperId, note } = opts || {};
  // 编辑已有条目时，默认沿用它现在的观点归属——保存后才能正确刷新观点文件
  const topicFileId = opts.topicFileId || (note && note.topic_file_id) || null;
  const isEdit = !!note;
  // 来源文献：编辑时从 note.paper / note.paper_id 取，新增时从 paperId 取
  // 编辑器顶部一直显示，方便确认「我正在给哪篇论文写思考」
  let sourcePaper = (note && note.paper) || null;
  const sourceId = paperId || (note && note.paper_id) || null;
  if (!sourcePaper && sourceId) {
    try {
      const d = await req("GET", "/api/paper?id=" + sourceId);
      sourcePaper = (d && (d.paper || d)) || null;
    } catch (e) { /* 渲染时兜底显示「未指定」 */ }
  }
  let sections;
  let composeImgSeq = 0;
  let flagged = isEdit ? !!note.flagged : false;

  const normBlock = (b) => b.type === "text"
    ? { key: b.key, type: "text", text: b.text || "" }
    : { key: b.key, type: "image", image_id: b.image_id, rel_path: b.image ? b.image.rel_path : (b.rel_path || "") };

  if (isEdit) {
    const built = buildSectionsFromNote(note);
    sections = built.sections.map(sec => ({ id: sec.id, col: sec.col, items: sec.items.map(normBlock) }));
    composeImgSeq = built.nextId;
  } else {
    sections = [{ id: "s1", col: "full", items: [{ key: "t" + Date.now(), type: "text", text: "" }] }];
    composeImgSeq = 1;
  }
  let secCounter = sections.length;
  const newKey = (p) => p + (++composeImgSeq) + "_" + Math.random().toString(36).slice(2, 6);

  const render = () => {
    // 防丢字：重渲染前必须把用户已经敲在输入框里的文字先同步回 sections，
    // 否则贴图/换栏/新增一栏/增删块都会用旧数据覆盖输入（用户写的话不能被挤没！）
    syncTextFromDOM();
    // 记住当前焦点所在的文本块与光标位置，重渲染后恢复
    const activeEl = document.activeElement;
    const activeBlock = activeEl && activeEl.closest ? activeEl.closest(".layout-block__edit") : null;
    const focusKey = activeBlock ? activeBlock.dataset.key : null;
    const caret = activeBlock ? getCaretOffset(activeBlock) : null;
    const secHtml = sections.map(sec => sectionHtml(sec)).join("");
    openModal(`
      <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
      <p class="eyebrow">${isEdit ? "EDIT NOTE" : "NEW NOTE"}</p>
      <h3>${isEdit ? "编辑思考" : "新增思考"}</h3>
      <div class="compose-source">
        <svg><use href="#i-book"/></svg>
        <div class="compose-source__text">
          <span>来源文献</span>
          <b>${esc((sourcePaper && (sourcePaper.title_en || sourcePaper.title_zh)) || "未指定")}</b>
          ${(sourcePaper && sourcePaper.title_en && sourcePaper.title_zh) ? "<small>" + esc(sourcePaper.title_zh) + "</small>" : ""}
        </div>
      </div>
      <div class="layout-sections" id="layout-sections">
        ${secHtml}
        <button class="layout-section__add" id="m-layout-add" type="button">＋ 新增一栏</button>
      </div>
      <div style="display:flex; gap:10px; align-items:center; margin-top:18px; flex-wrap:wrap;">
        <button class="scan-button scan-button--ghost note-flag-btn ${flagged ? "is-active" : ""}" id="m-note-flag" type="button" title="标记：这条思考可能还没想透，待复查">
          <svg style="width:13px;height:13px;"><use href="#i-flag"/></svg><span>${flagged ? "已标记" : "标记"}</span>
        </button>
        <button class="scan-button scan-button--ghost" id="m-compose-addimg" type="button"><svg style="width:13px;height:13px;"><use href="#i-image"/></svg><span>图片</span></button>
        <button class="scan-button scan-button--ghost" id="m-compose-addtext" type="button"><svg style="width:13px;height:13px;"><use href="#i-edit"/></svg><span>文字</span></button>
        <div style="flex:1;"></div>
        <button class="scan-button scan-button--ghost" id="m-layout-cancel" type="button">取消</button>
        <button class="scan-button" id="m-layout-save" type="button">${isEdit ? "保存修改" : "保存思考"}</button>
      </div>`);
    bindComposeDrag();
    $("#m-close").onclick = closeModal;
    $("#m-layout-cancel").onclick = closeModal;
    $("#m-layout-add").onclick = () => {
      sections.push({ id: "s" + (++secCounter), col: "full", items: [{ key: newKey("t"), type: "text", text: "" }] });
      render();
    };
    $("#m-compose-addimg").onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (file) addImageBlock(sections[sections.length - 1].id, file);
      };
      input.click();
    };
    $("#m-compose-addtext").onclick = () => {
      sections[sections.length - 1].items.push({ key: newKey("t"), type: "text", text: "" });
      render();
      // focus the new empty text block
      const edits = $$(".layout-block__edit");
      const last = edits[edits.length - 1];
      if (last) { last.focus(); placeCaretAtEnd(last); }
    };
    const flagBtn = $("#m-note-flag");
    flagBtn.onclick = () => {
      flagged = !flagged;
      flagBtn.classList.toggle("is-active", flagged);
      flagBtn.querySelector("span").textContent = flagged ? "已标记" : "标记";
    };
    $("#m-layout-save").onclick = () => saveCompose();
    // 恢复焦点与光标位置（贴图/改栏等重渲染不打断输入）
    if (focusKey) {
      const el = document.querySelector(`.layout-block__edit[data-key="${CSS.escape(focusKey)}"]`);
      if (el) {
        el.focus();
        if (caret != null) setCaretOffset(el, caret);
        else placeCaretAtEnd(el);
      }
    }
    const modalBody = $("#modal");
    modalBody.onpaste = (e) => {
      if (!document.getElementById("layout-sections")) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith("image/")) {
          e.preventDefault();
          const blob = it.getAsFile();
          const secEl = e.target.closest && e.target.closest(".layout-section");
          addImageBlock(secEl ? secEl.dataset.secid : sections[sections.length - 1].id, blob);
          return;
        }
      }
    };
  };

  function sectionHtml(sec) {
    const blocksHtml = sec.items.map(b => {
      if (b.type === "text") {
        return `<div class="layout-block layout-block--text" draggable="true" data-key="${b.key}">
          <span class="layout-block__grip" title="拖动排序">⠿</span>
          <div class="layout-block__edit" contenteditable="true" data-key="${b.key}">${esc(b.text).replace(/\n/g, "<br>")}</div>
          <button class="layout-block__del" data-key="${b.key}" type="button" title="删除此块">×</button>
        </div>`;
      }
      const src = b.data ? `data:image/${b.ext};base64,${b.data}` : `/assets/${encodeURI(b.rel_path)}`;
      return `<div class="layout-block layout-block--image" draggable="true" data-key="${b.key}">
        <span class="layout-block__grip" title="拖动排序">⠿</span>
        <img src="${src}" alt="截图" loading="lazy">
        <button class="layout-block__del" data-key="${b.key}" type="button" title="删除此图">×</button>
      </div>`;
    }).join("");
    return `
      <section class="layout-section" data-secid="${sec.id}" data-col="${sec.col}">
        <header class="layout-section__head" draggable="true" data-secid="${sec.id}">
          <span class="layout-section__grip" title="拖动排序">⠿</span>
          <select class="layout-section__type" data-secid="${sec.id}">
            <option value="1" ${sec.col == 1 ? "selected" : ""}>左栏</option>
            <option value="2" ${sec.col == 2 ? "selected" : ""}>右栏</option>
            <option value="full" ${sec.col === "full" ? "selected" : ""}>全宽</option>
          </select>
          <button class="layout-section__del" data-secid="${sec.id}" type="button" title="删除此栏">✕</button>
        </header>
        <div class="layout-section__items" data-secid="${sec.id}">${blocksHtml}</div>
      </section>`;
  }

  function addImageBlock(secId, blob) {
    blobToBase64(blob).then(b64 => {
      const ext = blob.type.includes("png") ? "png" : "jpg";
      const sec = sections.find(s => s.id === secId);
      if (!sec) return;
      sec.items.push({ key: newKey("n"), type: "image", data: b64, ext });
      render();
    });
  }

  // 只把 DOM 里已输入的文字回写到 sections 对应的 text 块，
  // 不重建结构（结构变动仍由各操作 handler 自己改 sections）。
  function syncTextFromDOM() {
    $$(".layout-block__edit").forEach(el => {
      sections.forEach(s => {
        const hit = s.items.find(b => b.key === el.dataset.key);
        if (hit && hit.type === "text") hit.text = el.innerText;
      });
    });
  }

  function syncSectionsFromDOM() {
    const next = [];
    $$(".layout-section").forEach(secEl => {
      const secId = secEl.dataset.secid;
      const col = secEl.dataset.col === "full" ? "full" : parseInt(secEl.dataset.col);
      const items = $$(".layout-block", secEl).map(el => {
        const key = el.dataset.key;
        let found = null;
        sections.forEach(s => { const hit = s.items.find(b => b.key === key); if (hit) found = hit; });
        if (found && found.type === "text") found = { ...found, text: el.querySelector(".layout-block__edit").innerText };
        return found;
      }).filter(Boolean);
      next.push({ id: secId, col, items });
    });
    sections = next;
  }

  function bindComposeDrag() {
    let drag = null;

    $$(".layout-block").forEach(el => {
      el.addEventListener("dragstart", (e) => {
        drag = { type: "block", key: el.dataset.key };
        el.classList.add("is-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "block:" + el.dataset.key);
        e.stopPropagation();
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("is-dragging");
        if (drag && drag.type === "block") { syncSectionsFromDOM(); drag = null; }
      });
    });

    $$(".layout-section__head").forEach(el => {
      el.addEventListener("dragstart", (e) => {
        drag = { type: "section", secId: el.dataset.secid };
        el.closest(".layout-section").classList.add("is-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "section:" + el.dataset.secid);
      });
    });

    $$(".layout-section__items").forEach(zone => {
      zone.addEventListener("dragover", (e) => {
        if (!drag || drag.type !== "block") return;
        e.preventDefault();
        const dragging = document.querySelector(".layout-block.is-dragging");
        if (!dragging) return;
        const after = getDragAfterElement(zone, e.clientY);
        if (after == null) zone.appendChild(dragging);
        else zone.insertBefore(dragging, after);
      });
      zone.addEventListener("drop", (e) => {
        if (!drag || drag.type !== "block") return;
        e.preventDefault();
        syncSectionsFromDOM();
        drag = null;
      });
    });

    $$(".layout-section").forEach(sec => {
      sec.addEventListener("dragover", (e) => {
        if (!drag || drag.type !== "section") return;
        e.preventDefault();
        if (sec.dataset.secid === drag.secId) return;
        const dragging = document.querySelector(".layout-section.is-dragging");
        if (!dragging) return;
        const after = getDragAfterSection(e.clientY);
        const container = $("#layout-sections");
        if (after == null) container.insertBefore(dragging, $("#m-layout-add"));
        else container.insertBefore(dragging, after);
      });
      sec.addEventListener("dragend", () => {
        const d = document.querySelector(".layout-section.is-dragging");
        if (d) d.classList.remove("is-dragging");
        if (drag && drag.type === "section") { syncSectionsFromDOM(); drag = null; }
      });
    });

    $$(".layout-section__type").forEach(sel => {
      sel.addEventListener("change", () => {
        const sec = sections.find(s => s.id === sel.dataset.secid);
        if (sec) { sec.col = sel.value === "full" ? "full" : parseInt(sel.value); render(); }
      });
    });

    $$(".layout-section__del").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.secid;
        const idx = sections.findIndex(s => s.id === id);
        if (idx < 0 || sections.length <= 1) return;
        const [removed] = sections.splice(idx, 1);
        const target = sections[idx] || sections[idx - 1];
        target.items = target.items.concat(removed.items);
        render();
      });
    });

    $$(".layout-block__del").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = btn.dataset.key;
        sections.forEach(s => { s.items = s.items.filter(b => b.key !== key); });
        render();
      });
    });
  }

  async function saveCompose() {
    syncSectionsFromDOM();
    const flat = [];
    let content = "";
    let newImages = [];
    let order = 0;
    sections.forEach(sec => {
      sec.items.forEach(b => {
        if (b.type === "text") {
          const t = b.text || "";
          if (!t.trim()) return;
          content += (content ? "\n[[blk]]\n" : "") + t;
          flat.push({ col: sec.col, order: order++ });
        } else {
          if (b.image_id) {
            content += (content ? "\n" : "") + `[[existing-img:${b.image_id}]]`;
          } else {
            const idx = newImages.length;
            newImages.push({ data: b.data, ext: b.ext });
            content += (content ? "\n" : "") + `[[img:${idx}]]`;
          }
          flat.push({ col: sec.col, order: order++ });
        }
      });
    });
    content = content.trim();
    if (!content && newImages.length === 0) {
      toast("先写点内容或加张图");
      return;
    }
    const layout = { blocks: flat };
    try {
      if (!isEdit) {
        const nd = await req("POST", "/api/notes", {
          paper_id: paperId, content,
          topic_file_id: topicFileId || null,
        });
        const nid = nd.id;
        for (const img of newImages) {
          await req("POST", "/api/notes/images", { note_id: nid, data: img.data, ext: img.ext });
        }
        await req("PUT", "/api/notes/layout", { id: nid, layout });
        // 撤销新增 = 软删（进历史版本，连同归属）；重做 = 从历史版本恢复
        pushUndo("新增思考",
          async () => { await req("DELETE", "/api/notes?id=" + nid); },
          async () => { await restoreNotesByIds([nid]); });
        toast("已新增思考");
      } else {
        // 撤销/重做编辑：PUT 会物理删除未被内容引用的图片文件，
        // 所以旧内容必须用 [[existing-img:ID]] 回写（复用还活着的图，不丢文件）；
        // 重做则带上原始 base64 重传新图。编辑前保存时后端已写入历史版本兜底。
        const oldContent = note.content || "";
        const oldImgIds = (note.images || []).map(i => i.id);
        const oldContentAsExisting = oldContent.replace(/\[\[img:(\d+)\]\]/g, (m, n) => {
          const iid = oldImgIds[parseInt(n, 10)];
          return iid ? `[[existing-img:${iid}]]` : "";
        });
        const oldLayout = note.layout;
        const oldFlagged = note.flagged;
        await req("PUT", "/api/notes", { id: note.id, content, images: newImages, flagged });
        await req("PUT", "/api/notes/layout", { id: note.id, layout });
        pushUndo("编辑思考",
          async () => {
            await req("PUT", "/api/notes", { id: note.id, content: oldContentAsExisting, images: [], flagged: oldFlagged });
            if (oldLayout) await req("PUT", "/api/notes/layout", { id: note.id, layout: oldLayout });
          },
          async () => {
            await req("PUT", "/api/notes", { id: note.id, content, images: newImages, flagged });
            await req("PUT", "/api/notes/layout", { id: note.id, layout });
          });
        toast("已保存修改");
      }
      closeModal();
      if (state._viewPaper) await openPaperView(state._viewPaper.id);
      if (paperId && state._currentPaper && state._currentPaper.id === paperId) await refreshPaper(paperId);
      else if (isEdit && state._currentPaper && state._currentPaper.id === note.paper_id) await refreshPaper(note.paper_id);
      if (topicFileId && TOPIC_CURRENT_FILE && TOPIC_CURRENT_FILE.id === topicFileId) await openTopicFile(TOPIC_CURRENT_FILE);
    } catch (e) { toast(e.message, true); }
  }

  function getDragAfterElement(container, y) {
    const els = [...container.querySelectorAll(".layout-block:not(.is-dragging)")];
    return els.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  function getDragAfterSection(y) {
    const els = [...document.querySelectorAll(".layout-section:not(.is-dragging)")];
    return els.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  render();
}

/* ============ 编辑已有思考 ============ */
function renderNoteEditorContent(n) {
  const content = n.content || "";
  const images = n.images || [];
  const re = /\[\[(?:img:(\d+)|blk)\]\]/g;
  let html = "";
  let last = 0;
  let m;
  while ((m = re.exec(content)) !== null) {
    html += esc(content.slice(last, m.index));
    const idx = parseInt(m[1]);
    const img = images[idx];
    if (img) {
      html += `<img src="/assets/${encodeURI(img.rel_path)}" data-existing-id="${img.id}" class="compose-img" alt="截图">`;
    }
    last = m.index + m[0].length;
  }
  html += esc(content.slice(last));
  html = html.replace(/\n/g, "<br>");
  return html || "<div><br></div>";
}

function serializeNoteEditor(editor) {
  let content = "";
  const images = [];
  const idxMap = {};
  const existingIdMap = {};
  const walk = (node) => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { content += ch.textContent; }
      else if (ch.nodeName === "IMG") {
        const existingId = ch.dataset.existingId;
        if (existingId) {
          if (!(existingId in existingIdMap)) {
            existingIdMap[existingId] = Object.keys(existingIdMap).length;
          }
          content += `[[existing-img:${existingId}]]`;
        } else {
          const oidx = parseInt(ch.dataset.idx);
          if (!(oidx in idxMap) && state.editImages[oidx]) {
            idxMap[oidx] = images.length;
            images.push(state.editImages[oidx]);
          }
          if (oidx in idxMap) content += `[[img:${idxMap[oidx]}]]`;
        }
      }
      else if (ch.nodeName === "BR") { content += "\n"; }
      // Chrome 的 contenteditable 按 Enter 会产生 <div>，裸文本节点后紧跟 <div>/<p> 时
      // 必须先补一个换行，否则第一行和第二行会被 walk 挤到一起（换行丢失的根因）
      else if (ch.nodeName === "DIV" || ch.nodeName === "P") { if (content && !content.endsWith("\n")) content += "\n"; walk(ch); content += "\n"; }
      else { walk(ch); }
    });
  };
  walk(editor);
  return { content, images };
}

function insertEditImage(blob, editor) {
  blobToBase64(blob).then(b64 => {
    const ext = blob.type.includes("png") ? "png" : "jpg";
    const idx = state.editImages.length;
    state.editImages.push({ data: b64, ext });
    const img = document.createElement("img");
    img.src = "data:image/" + ext + ";base64," + b64;
    img.dataset.idx = idx;
    img.className = "compose-img";
    const sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(img);
    }
    editor.focus();
  });
}

function openNoteEditor(note) {
  openNoteComposeEditor({ note });
}

/* ============ 弹窗 ============ */
function openModal(html, cls) {
  const m = $("#modal");
  m.className = "modal" + (cls ? " " + cls : "");
  m.innerHTML = html;
  $("#modal-backdrop").hidden = false;
}
function closeModal() {
  const m = $("#modal");
  m.className = "modal";
  m.innerHTML = "";
  $("#modal-backdrop").hidden = true;
}
// 注意：不再给遮罩绑定“点击空白处关闭”。数据录入弹框（导入/编辑论文、新建项目/文件夹）
// 必须显式通过右上角叉叉或保存按钮关闭，避免误点空白处丢失已填内容。

/* 新建项目 */
function openProjectModal() {
  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">NEW PROJECT</p>
    <h3>新建项目</h3>
    <p class="modal-hint">一个项目对应一个课题。项目里可以建无限嵌套的文件夹来组织论文。</p>
    <div class="form-row"><label>项目名</label><input id="m-name" placeholder="例如：反渗透膜隔网 CFD 仿真"></div>
    <div class="form-row"><label>备注（可选）</label><textarea id="m-note" placeholder="这个课题在研究什么"></textarea></div>
    <button class="scan-button" id="m-save" type="button"><span>创建项目</span></button>`);
  $("#m-close").onclick = closeModal;
  $("#m-save").onclick = async () => {
    const name = $("#m-name").value.trim();
    if (!name) { toast("请输入项目名"); return; }
    try {
      const pr = await req("POST", "/api/projects", { name, note: $("#m-note").value.trim() });
      // 撤销新建项目 = 软删进回收站；重做 = 从回收站恢复
      pushUndo("新建项目「" + name + "」",
        async () => { await req("POST", "/api/projects/delete", { ids: [pr.id] }); },
        async () => { await restoreRecycleByEntities("project", [pr.id]); });
      closeModal();
      toast("项目已创建");
      await loadProjects();
      renderNav();
      renderProjects();
    } catch (e) { toast(e.message, true); }
  };
}

/* 新建文件夹 */
function openFolderModal(parentId) {
  const parentName = parentId ? (findFolder(state.folderTree, parentId)?.name || "") : "根目录";
  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">NEW FOLDER</p>
    <h3>新建文件夹</h3>
    <p class="modal-hint">在「${esc(parentName)}」下创建子文件夹。</p>
    <div class="form-row"><label>文件夹名</label><input id="m-name" placeholder="例如：文献综述 / 实验数据 / CFD 建模"></div>
    <button class="scan-button" id="m-save" type="button"><span>创建文件夹</span></button>`);
  $("#m-close").onclick = closeModal;
  $("#m-save").onclick = async () => {
    const name = $("#m-name").value.trim();
    if (!name) { toast("请输入文件夹名"); return; }
    try {
      const fr = await req("POST", "/api/folders", { project_id: state.currentProjectId, parent_id: parentId || null, name });
      // 撤销新建文件夹 = 软删进回收站；重做 = 从回收站恢复
      pushUndo("新建文件夹「" + name + "」",
        async () => { await req("DELETE", "/api/folders?id=" + fr.id); },
        async () => { await restoreRecycleByEntities("folder", [fr.id]); });
      closeModal();
      toast("文件夹已创建");
      await loadTree();
      await loadProjects();
    } catch (e) { toast(e.message, true); }
  };
}

async function deleteFolder(fid) {
  const node = findFolder(state.folderTree, fid);
  const extra = node && node.children && node.children.length ? "（含其所有子文件夹）" : "";
  if (!confirm(`删除文件夹「${node?.name || ""}」${extra}？其中的论文会一起进入回收站，可在 7 天内恢复。`)) return;
  const r = await req("DELETE", "/api/folders?id=" + fid);
  pushUndo("删除文件夹「" + (node?.name || "") + "」",
    async () => { await restoreRecycleByEntities("folder", [fid]); },
    async () => { await req("DELETE", "/api/folders?id=" + fid); });
  toast(r.message || "已删除");
  state.selFolders.delete(fid);
  if (state.currentFolderId === fid) { state.currentFolderId = null; state.currentFolderPath = []; }
  await loadTree();
  await loadPapers();
  await loadProjects();
  await loadRecycle(false);
  renderNav();
  updateSelectionUI();
}

/* 导入论文（弹窗：拖拽 PDF / 选文件）；onSaved(newPaperId) —— 保存成功后回调（供来源文献选择器等场景接续） */
function openPaperModal(existing, onSaved) {
  const isEdit = !!existing;
  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">${isEdit ? "EDIT PAPER" : "IMPORT PAPER"}</p>
    <h3>${isEdit ? "编辑论文" : "导入论文"}</h3>
    <p class="modal-hint">${isEdit ? "" : "拖入或选择本地 PDF，自动提取标题 / 作者 / 期刊 / 日期 / DOI；也可手动填写。"}</p>
    ${isEdit ? "" : `
    <div class="drop-zone" id="drop-zone">
      <svg><use href="#i-upload"/></svg>
      <p><b>拖入 PDF 文件</b> 或点击选择</p>
      <p class="dz-sub" id="dz-sub">上传后自动解析论文信息</p>
      <input type="file" id="pdf-file" accept=".pdf,application/pdf" hidden>
    </div>
    <div id="dup-warn-box"></div>`}
    <div class="form-row"><label>英文标题</label><input id="m-title_en" value="${esc(existing?.title_en || "")}"></div>
    <div class="form-row"><label>中文标题</label><input id="m-title_zh" value="${esc(existing?.title_zh || "")}"></div>
    <div class="form-grid2">
      <div class="form-row"><label>期刊</label><input id="m-journal" value="${esc(existing?.journal || "")}"></div>
      <div class="form-row"><label>发表日期</label><input id="m-date" value="${esc(existing?.publish_date || "")}" placeholder="如 2026-03-15"></div>
    </div>
    <div class="form-row"><label>作者</label><input id="m-authors" value="${esc(existing?.authors || "")}" placeholder="多个作者用逗号分隔"></div>
    <div class="form-grid2">
      <div class="form-row"><label>DOI</label><input id="m-doi" value="${esc(existing?.doi || "")}"></div>
      <div class="form-row"><label>链接（可选）</label><input id="m-url" value="${esc(existing?.url || "")}"></div>
    </div>
    <div class="form-row"><label>本地 PDF 路径（可选，用于「打开论文」跳转）</label><input id="m-path" value="${esc(existing?.local_path || "")}" placeholder="D:\\科研\\课题A\\paper.pdf"><div class="field-help">指向你电脑里那篇真实 PDF 的完整路径，之后可一键打开。</div></div>
    <div id="m-path-cands"></div>
    <button class="scan-button" id="m-save" type="button"><span>${isEdit ? "保存修改" : "保存论文"}</span></button>`);

  $("#m-close").onclick = closeModal;

  const targetFolderId = () => {
    // 当前选中的文件夹，或根目录
    return state.currentFolderId || null;
  };

  $("#m-save").onclick = async () => {
    const payload = {
      title_en: $("#m-title_en").value.trim(),
      title_zh: $("#m-title_zh").value.trim(),
      journal: $("#m-journal").value.trim(),
      authors: $("#m-authors").value.trim(),
      publish_date: $("#m-date").value.trim(),
      doi: $("#m-doi").value.trim(),
      url: $("#m-url").value.trim(),
      local_path: $("#m-path").value.trim(),
    };
    try {
      if (isEdit) {
        // 撤销编辑论文 = 存回旧字段；重做 = 再存新字段
        const oldFields = {
          title_en: existing.title_en || "", title_zh: existing.title_zh || "",
          journal: existing.journal || "", authors: existing.authors || "",
          publish_date: existing.publish_date || "", doi: existing.doi || "",
          url: existing.url || "", local_path: existing.local_path || "",
        };
        await req("PUT", "/api/papers", { id: existing.id, ...payload });
        pushUndo("编辑论文信息",
          async () => { await req("PUT", "/api/papers", { id: existing.id, ...oldFields }); },
          async () => { await req("PUT", "/api/papers", { id: existing.id, ...payload }); });
        toast("已保存修改");
        closeModal();
        if (onSaved) onSaved(existing.id);
        await openPaperDrawer(existing.id);
        await loadPapers();
      } else {
        let fid = targetFolderId();
        if (!fid) {
          // 根目录：后端要求 folder_id，这里确保有至少一个文件夹并选中它
          await ensureRootFolder();
          fid = state.currentFolderId;
        }
        // 导入查重：DOI 优先，其次标题。命中且用户没确认过「仍然导入」就先弹选择框
        if (!DUP_FORCE_IMPORT) {
          const hits = await checkPaperDuplicate(payload.doi, payload.title_en || payload.title_zh);
          if (hits.length) { openDupChoiceModal(hits, payload, fid); return; }
        }
        const r = await req("POST", "/api/papers", { folder_id: fid, ...payload });
        // 撤销导入 = 软删进回收站；重做 = 从回收站恢复
        pushUndo("导入论文",
          async () => { await req("DELETE", "/api/papers?id=" + r.id); },
          async () => { await restoreRecycleByEntities("paper", [r.id]); });
        toast("论文已保存");
        closeModal();
        if (onSaved) onSaved(r && r.id);
        await loadTree();
        await loadPapers();
        await loadProjects();
        await loadDupCount();
      }
    } catch (e) { toast(e.message, true); }
  };
  DUP_FORCE_IMPORT = false;

  if (!isEdit) {
    const dz = $("#drop-zone");
    const fileInput = $("#pdf-file");
    dz.addEventListener("click", () => fileInput.click());
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("is-drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("is-drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("is-drag");
      const f = e.dataTransfer.files[0];
      if (f) handlePdfFile(f);
    });
    fileInput.addEventListener("change", () => { if (fileInput.files[0]) handlePdfFile(fileInput.files[0]); });
  }
}

async function ensureRootFolder() {
  // 根目录没有 folder 时，自动建一个"默认"文件夹
  await loadTree();
  if (!state.folderTree.length) {
    const r = await req("POST", "/api/folders", { project_id: state.currentProjectId, parent_id: null, name: "默认" });
    await loadTree();
    state.currentFolderId = r.id;
    state.currentFolderPath = [{ id: r.id, name: "默认" }];
  } else if (!state.currentFolderId) {
    // 有文件夹但没选中，选中第一个
    state.currentFolderId = state.folderTree[0].id;
    state.currentFolderPath = [{ id: state.folderTree[0].id, name: state.folderTree[0].name }];
  }
  renderTree();
  renderCrumbs();
}

async function handlePdfFile(file) {
  const dz = $("#drop-zone");
  const sub = $("#dz-sub");
  dz.classList.add("is-drag");
  sub.textContent = "正在解析 PDF 提取论文信息…";
  try {
    const dataB64 = await fileToBase64(file);
    const r = await req("POST", "/api/pdf/extract", { data: dataB64 });
    const meta = r.meta || {};
    if (meta.title_en) $("#m-title_en").value = meta.title_en;
    if (meta.title_zh) $("#m-title_zh").value = meta.title_zh;
    if (meta.journal) $("#m-journal").value = meta.journal;
    if (meta.authors) $("#m-authors").value = meta.authors;
    if (meta.publish_date) $("#m-date").value = meta.publish_date;
    if (meta.doi) $("#m-doi").value = meta.doi;
    // 自动定位本地路径：按文件名在论文目录搜索同名 PDF。
    // 多个同名时不许静默取第一个——必须让用户挑（否则会绑到专利材料等错误位置）。
    try {
      const fl = await req("POST", "/api/find_local", { filename: file.name });
      const cands = fl.paths || [];
      const candsBox = $("#m-path-cands");
      if (cands.length === 1) {
        $("#m-path").value = cands[0].path;
        sub.textContent = "已自动提取，并定位到本地文件路径";
        if (candsBox) candsBox.innerHTML = "";
      } else if (cands.length > 1) {
        const fmtSize = (n) => n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + " MB" : (n / 1024).toFixed(0) + " KB";
        $("#m-path").value = "";
        sub.textContent = `已自动提取；发现 ${cands.length} 个同名 PDF，请在下方选择实际位置`;
        if (candsBox) {
          candsBox.innerHTML = `
            <div class="form-row"><label>发现 ${cands.length} 个同名 PDF，请选择实际位置（必选）</label>
              <select id="m-path-pick" style="width:100%;min-height:36px;padding:4px 8px;font:500 .84rem var(--font-data);color:var(--ink-900);background:white;border:1px solid var(--paper-300);border-radius:3px;box-sizing:border-box;">
                <option value="">— 请选择 —</option>
                ${cands.map((c, i) => `<option value="${esc(c.path)}">${i + 1}. ${esc(c.path.replace(/^[A-Za-z]:\\/, ""))}（${fmtSize(c.size || 0)}，${esc(c.modified || "未知时间")}）</option>`).join("")}
              </select>
              <div class="field-help">同名文件出现在多个位置（如论文目录和专利材料目录），选错会导致「打开所在文件夹」跳错地方。</div>
            </div>`;
          $("#m-path-pick").onchange = () => { $("#m-path").value = $("#m-path-pick").value; };
        }
      } else {
        sub.textContent = "已自动提取，但未在论文目录找到同名文件，本地路径需手动填写";
        if (candsBox) candsBox.innerHTML = "";
      }
    } catch (e2) {
      sub.textContent = "已自动提取，请核对后保存";
    }
    // 文件名作为标题兜底
    if (!meta.title_en && file.name.toLowerCase().endsWith(".pdf")) {
      $("#m-title_en").value = file.name.replace(/\.pdf$/i, "");
    }
    await renderImportDupWarn();
    toast("解析完成，请核对信息");
  } catch (e) {
    sub.textContent = "解析失败，请手动填写";
    if (file.name.toLowerCase().endsWith(".pdf")) {
      $("#m-title_en").value = file.name.replace(/\.pdf$/i, "");
    }
    toast(e.message, true);
  } finally {
    dz.classList.remove("is-drag");
  }
}

/* ============ 重复论文：导入查重 + 批量清理 ============ */
let DUP_FORCE_IMPORT = false;   // 用户在查重弹窗里点了「仍然导入」时为 true

/* 查重：DOI 优先，其次标题。返回命中的已有论文列表 */
async function checkPaperDuplicate(doi, title) {
  try {
    const d = await req("POST", "/api/papers/check_duplicate", { doi: doi || "", title: title || "" });
    return d.duplicates || [];
  } catch (e) {
    return [];
  }
}

/* 导入弹窗里的即时提示（不打断填写，只在保存时强制选择） */
async function renderImportDupWarn() {
  const box = $("#dup-warn-box");
  if (!box) return;
  const hits = await checkPaperDuplicate($("#m-doi").value.trim(), $("#m-title_en").value.trim() || $("#m-title_zh").value.trim());
  if (!hits.length) { box.innerHTML = ""; return; }
  const fuzzy = hits.some(h => h.match === "fuzzy");
  box.innerHTML = `
    <div class="dup-warn">
      <b>${fuzzy ? "库里可能已经有这篇论文（标题前段一致），保存时会让你确认" : "库里已经有这篇论文，保存时会让你选择怎么处理"}</b>
      <p>${hits.slice(0, 3).map(h => `· ${esc(h.title_zh || h.title_en)}（${esc(h.project_name)} / ${esc(h.folder_name)}，${h.note_count} 条思考）`).join("<br>")}</p>
    </div>`;
}

/* 命中重复时的三选一：引用已有 / 打开已有 / 仍然导入 */
function openDupChoiceModal(hits, payload, folderId) {
  const pick = hits[0];
  const fuzzy = hits.some(h => h.match === "fuzzy");
  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">DUPLICATE CHECK</p>
    <h3>${fuzzy ? "库里可能已经有这篇论文" : "库里已经有这篇论文"}</h3>
    <p class="modal-hint">${fuzzy
      ? `没找到完全一致的 DOI 或标题，但有 ${hits.length} 条记录的标题前段与它一致，很可能是同一篇。同一篇论文应该只有一条记录，条目挂在一条上才不会散开。`
      : `导入前查重命中 ${hits.length} 条已有记录。同一篇论文应该只有一条记录，条目挂在一条上才不会散开。`}</p>
    <div class="picker-list">
      ${hits.map((h) => `
        <div class="picker-row" data-id="${h.id}">
          <b>${esc(h.title_zh || h.title_en || "(无标题)")}</b>
          <small>${esc(h.project_name)} / ${esc(h.folder_name)} · ${h.note_count} 条思考${h.doi ? " · DOI " + esc(h.doi) : ""}${h.match === "fuzzy" ? " · 疑似重复" : ""}</small>
        </div>`).join("")}
    </div>
    <div class="dup-choice">
      <button class="scan-button" id="dup-share" type="button"><span>引用已有论文到当前文件夹</span></button>
      <button class="scan-button scan-button--ghost" id="dup-open" type="button"><span>打开已有论文</span></button>
      <button class="scan-button scan-button--ghost" id="dup-force" type="button"><span>仍然导入为新论文</span></button>
    </div>`);
  $("#m-close").onclick = closeModal;

  let chosen = pick.id;
  $$(".picker-row").forEach(row => {
    row.onclick = () => {
      chosen = Number(row.dataset.id);
      $$(".picker-row").forEach(r => r.style.background = (r === row ? "rgba(31,91,87,.11)" : ""));
    };
  });
  // 默认高亮第一条
  const first = $(".picker-row");
  if (first) first.style.background = "rgba(31,91,87,.11)";

  $("#dup-share").onclick = async () => {
    try {
      await req("POST", "/api/papers/share", { paper_id: chosen, folder_id: folderId });
      pushUndo("共享论文到文件夹",
        async () => { await req("DELETE", "/api/papers/unshare?paper_id=" + chosen + "&folder_id=" + folderId); },
        async () => { await req("POST", "/api/papers/share", { paper_id: chosen, folder_id: folderId }); });
      closeModal();
      toast("已引用库内已有论文，没有产生重复记录");
      await loadTree();
      await loadPapers();
      await loadProjects();
      await openPaperDrawer(chosen);
    } catch (e) { toast(e.message, true); }
  };
  $("#dup-open").onclick = async () => {
    closeModal();
    await openPaperDrawer(chosen);
  };
  $("#dup-force").onclick = async () => {
    try {
      const r = await req("POST", "/api/papers", { folder_id: folderId, ...payload });
      pushUndo("导入论文",
        async () => { await req("DELETE", "/api/papers?id=" + r.id); },
        async () => { await restoreRecycleByEntities("paper", [r.id]); });
      DUP_FORCE_IMPORT = false;
      closeModal();
      toast("已导入为新论文（之后可在「重复清理」里合并）");
      await loadTree();
      await loadPapers();
      await loadProjects();
      await loadDupCount();
    } catch (e) { toast(e.message, true); }
  };
}

/* 侧栏「重复清理」：扫描全库重复论文并合并 */
async function loadDupCount() {
  const btn = $("#dup-btn");
  if (!btn) return;
  try {
    const d = await req("GET", "/api/papers/duplicates");
    const n = (d.groups || []).length;
    const badge = $("#dup-side-count");
    if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
    btn.title = n ? `库里有 ${n} 组重复论文，点击合并（每组保留一条，其余进回收站 7 天可恢复）` : "暂无重复论文";
  } catch (e) { /* 静默失败，不影响主流程 */ }
}

function dupKeepRecommendation(items) {
  // 推荐保留：条目最多的那条；并列时取最早导入的（id 最小）
  return items.slice().sort((a, b) => (b.note_count - a.note_count) || (a.id - b.id))[0].id;
}

function renderDupGroups(groups) {
  const body = groups.length ? groups.map((g, gi) => `
    <div class="dup-group" data-gi="${gi}">
      <header>
        <b>${esc(g.title)}</b>
        <small>${g.doi ? "DOI " + esc(g.doi) : "（无 DOI，按标题判定重复）"} · 共 ${g.total_notes} 条思考</small>
      </header>
      <div class="dup-rows">
        ${g.papers.map(p => `
          <label class="dup-row${p.id === dupKeepRecommendation(g.papers) ? " is-keep" : ""}" data-gi="${gi}" data-id="${p.id}">
            <input type="radio" name="dup-g${gi}" value="${p.id}" ${p.id === dupKeepRecommendation(g.papers) ? "checked" : ""}>
            <div class="dup-row__main">
              <span>${esc(p.title_zh || p.title_en || "(无标题)")}</span>
              <small>#${p.id} · ${esc(p.project_name)} / ${esc(p.folder_name)} · ${esc((p.created_at || "").slice(0, 10))}</small>
            </div>
            <span class="dup-row__badge${p.note_count ? " is-note" : ""}">${p.note_count} 条思考</span>
          </label>`).join("")}
      </div>
      <div class="dup-actions">
        <button class="scan-button scan-button--ghost" data-merge="${gi}" type="button"><span>合并这组</span></button>
      </div>
    </div>`).join("") : `<p class="dup-empty">没有发现重复论文。<br>同一篇论文在不同项目里重复导入时，这里会列出来供你合并。</p>`;

  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">DUPLICATE CLEANUP</p>
    <h3>重复论文清理</h3>
    <p class="dup-hint">按 DOI（无 DOI 时按标题）找出库里重复导入的同一篇论文。每组选一条<strong>保留</strong>，其余的条目会全部归拢到保留的那条上，被合并的记录进回收站（7 天内可恢复）。</p>
    <div id="dup-list">${body}</div>
    ${groups.length > 1 ? `<div class="dup-actions"><button class="scan-button" id="dup-merge-all" type="button"><span>一键合并全部 ${groups.length} 组</span></button></div>` : ""}`);
  $("#m-close").onclick = closeModal;

  const syncKeep = () => {
    $$(".dup-row").forEach(row => {
      const input = row.querySelector("input[type=radio]");
      row.classList.toggle("is-keep", !!input && input.checked);
    });
  };
  $$(".dup-row").forEach(row => {
    row.addEventListener("click", () => { const i = row.querySelector("input[type=radio]"); if (i) { i.checked = true; syncKeep(); } });
  });

  const mergeOne = async (gi) => {
    const g = groups[gi];
    if (!g) return;
    const checked = $(`.dup-row[data-gi="${gi}"] input[type=radio]:checked`);
    const keepId = checked ? Number(checked.value) : dupKeepRecommendation(g.papers);
    const mergeIds = g.papers.map(p => p.id).filter(id => id !== keepId);
    if (!mergeIds.length) return;
    const moved = g.papers.filter(p => p.id !== keepId).reduce((s, p) => s + p.note_count, 0);
    if (!confirm(`保留「${keepId}」这条，合并其余 ${mergeIds.length} 条${moved ? `（${moved} 条思考会归拢过来）` : ""}？\n\n被合并的记录会进入回收站，7 天内可恢复。`)) return;
    try {
      const r = await req("POST", "/api/papers/merge", { keep_id: keepId, merge_ids: mergeIds });
      toast(`已合并：${r.merged} 条记录并入 #${keepId}，${r.moved_notes} 条思考已归拢`);
      await afterDupChange();
    } catch (e) { toast(e.message, true); }
  };
  $$("[data-merge]").forEach(b => { b.onclick = () => mergeOne(Number(b.dataset.merge)); });

  const all = $("#dup-merge-all");
  if (all) {
    all.onclick = async () => {
      if (!confirm(`将按推荐方案（每组保留条目最多的一条）合并全部 ${groups.length} 组，被合并的记录进回收站，7 天内可恢复。继续？`)) return;
      let merged = 0;
      for (const g of groups) {
        const keepId = dupKeepRecommendation(g.papers);
        const mergeIds = g.papers.map(p => p.id).filter(id => id !== keepId);
        if (!mergeIds.length) continue;
        try {
          await req("POST", "/api/papers/merge", { keep_id: keepId, merge_ids: mergeIds });
          merged += mergeIds.length;
        } catch (e) { /* 单组失败不打断其他组 */ }
      }
      toast(`已合并 ${merged} 条重复记录`);
      await afterDupChange();
    };
  }
}

async function afterDupChange() {
  await loadTree();
  await loadPapers();
  await loadProjects();
  await loadRecycle(false);
  closeModal();
  await openDuplicateModal();
  await loadDupCount();
}

async function openDuplicateModal() {
  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">DUPLICATE CLEANUP</p>
    <h3>重复论文清理</h3>
    <p class="dup-hint">正在扫描…</p>`);
  $("#m-close").onclick = closeModal;
  try {
    const d = await req("GET", "/api/papers/duplicates");
    renderDupGroups(d.groups || []);
  } catch (e) {
    openModal(`
      <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
      <h3>扫描失败</h3>
      <p class="dup-hint">${esc(e.message || "未知错误")}</p>`);
    $("#m-close").onclick = closeModal;
  }
}

/* ============ 初始化 ============ */
function bindGlobal() {
  $("#auth-submit").addEventListener("click", doAuth);
  $("#auth-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth(); });
  $("#auth-username").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#auth-password").focus(); });
  $("#new-project-btn").addEventListener("click", openProjectModal);
  $("#add-folder-btn").addEventListener("click", () => openFolderModal(state.currentFolderId));
  $("#add-paper-btn").addEventListener("click", () => openPaperModal(null));
  $("#share-paper-btn").addEventListener("click", () => openSharePaperModal());
  $("#root-folder-btn").addEventListener("click", () => openFolderModal(null));
  $("#logout-btn").addEventListener("click", () => doLogout());
  $("#paper-search").addEventListener("input", (e) => { state.searchTerm = e.target.value; renderPapers(); });
  $("#drawer-close").addEventListener("click", closeDrawer);
  // 批量删除工具条
  $("#bulk-delete-btn").addEventListener("click", doBulkDelete);
  $("#bulk-clear-sel").addEventListener("click", () => {
    state.continuousSelection = false;
    clearSelection();
  });
  $("#bulk-continuous-selection").addEventListener("click", () => {
    state.continuousSelection = !state.continuousSelection;
    updateSelectionUI();
    toast(state.continuousSelection ? "连续选择已开启：点击行直接多选" : "连续选择已关闭");
  });
  // 回收站
  const recycleBtn = $("#recycle-btn");
  if (recycleBtn) recycleBtn.addEventListener("click", openRecycle);
  const recycleTopBtn = $("#recycle-open-btn");
  if (recycleTopBtn) recycleTopBtn.addEventListener("click", openRecycle);
  const historyBtn = $("#history-btn");
  if (historyBtn) historyBtn.addEventListener("click", openHistory);
  const dupBtn = $("#dup-btn");
  if (dupBtn) dupBtn.addEventListener("click", openDuplicateModal);
  $("#recycle-restore-btn").addEventListener("click", restoreSelectedRecycle);
  $("#recycle-purge-btn").addEventListener("click", purgeSelectedRecycle);
  $("#recycle-clear-sel").addEventListener("click", clearSelection);
  // Esc 清空选择
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") clearSelection(); });
}

function init() {
  bindGlobal();
  bindTopics();
  updateAuthUI();
  if (API.token) {
    enterApp();
  } else {
    showAuth();
  }
  // 健康检查
  fetch("/api/health").then(r => r.json()).then(d => {
    $("#service-dot").classList.add("is-live");
    $("#service-state").textContent = "服务在线";
  }).catch(() => {
    $("#service-state").textContent = "未连接";
  });
}

document.addEventListener("DOMContentLoaded", init);

/* ============ 观点库（全局一套，不隶属于项目） ============ */
let TOPIC_TREE = [];
let TOPIC_CURRENT_FILE = null;   // 当前打开的叶子「文件」节点
let TOPIC_CURRENT_PARENT = null; // 当前选中的观点/文件夹（作为新建的父节点）

function bindTopics() {
  const sw = $("#view-switch");
  if (!sw) return;
  $$(".view-switch__btn", sw).forEach(btn => {
    btn.addEventListener("click", () => setViewMode(btn.dataset.viewmode));
  });
  // 新建观点 / 新建文件夹：建在当前选中的文件夹里；没选中就建在顶层
  const addTopic = $("#add-topic-btn");
  if (addTopic) addTopic.addEventListener("click", () => createTopicNode("topic", currentTopicParentId()));
  const addFolder = $("#add-topic-folder-btn");
  if (addFolder) addFolder.addEventListener("click", () => createTopicNode("folder", currentTopicParentId()));
  const addNote = $("#topic-add-note-btn");
  if (addNote) addNote.addEventListener("click", () => {
    if (TOPIC_CURRENT_FILE) openTopicNoteComposer(TOPIC_CURRENT_FILE.id);
  });
}

function setViewMode(mode) {
  state.viewMode = mode;
  $$(".view-switch__btn").forEach(b => {
    const on = b.dataset.viewmode === mode;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (mode === "topics") {
    showView("topics");
  } else {
    showView("projects");
  }
}

function currentTopicParentId() {
  // 只有选中的是「文件夹」时才作为父级；选中观点 / 什么都没选 → 建在顶层。
  // 否则先建了观点再点它，「新建文件夹」会永远没地方落（观点是叶子，不能挂子级）。
  if (TOPIC_CURRENT_PARENT && TOPIC_CURRENT_PARENT.kind === "folder") return TOPIC_CURRENT_PARENT.id;
  return null;
}

async function loadTopicTree() {
  try {
    const d = await req("GET", "/api/topics/tree");
    TOPIC_TREE = d.topics || [];
  } catch (e) {
    TOPIC_TREE = [];
  }
  renderTopicTree();
}

/* 观点树：与论文视图的文件夹树同一套结构 —— 可折叠箭头、行内新建/删除、计数、缩进连线 */
let TOPIC_OPEN = {}; // 折叠状态（undefined = 默认展开）

function renderTopicTree() {
  const host = $("#topic-tree");
  if (!host) return;
  const renderNode = (node) => {
    const isOpen = TOPIC_OPEN[node.id] !== false;
    const hasChildren = node.children && node.children.length > 0;
    const activeId = TOPIC_CURRENT_FILE ? TOPIC_CURRENT_FILE.id
      : (TOPIC_CURRENT_PARENT ? TOPIC_CURRENT_PARENT.id : null);
    const isActive = activeId === node.id;
    const icon = node.kind === "topic" ? "#i-flag" : "#i-folder";
    const isTopic = node.kind === "topic";
    return `
      <div class="tree-folder" data-tid="${node.id}">
        <div class="tree-row ${isActive ? "is-active" : ""} ${isOpen && hasChildren ? "is-open" : ""}" data-tid="${node.id}" data-kind="${node.kind}">
          <svg class="tree-chevron ${hasChildren ? "" : "is-leaf"}"><use href="#i-chevron"/></svg>
          <svg class="folder-ico"><use href="${icon}"/></svg>
          <span class="tree-name">${esc(node.name)}</span>
          <span class="tree-count" title="${isTopic ? "该观点共 " + (node.entry_count || 0) + " 条条目" : "含子级观点共 " + (node.entry_count || 0) + " 条条目"}">${node.entry_count || 0}</span>
          <span class="tree-actions">
            ${isTopic ? "" : `
            <button data-act="addf" title="新建子文件夹"><svg><use href="#i-folder"/></svg></button>
            <button data-act="addt" title="新建观点（观点直接装条目）"><svg><use href="#i-flag"/></svg></button>`}
            <button data-act="move" title="移动到别的文件夹（含全部子级）"><svg><use href="#i-arrow"/></svg></button>
            <button data-act="del" title="删除（其下条目会变回游民，思考不会丢）"><svg><use href="#i-trash"/></svg></button>
          </span>
        </div>
        ${hasChildren && isOpen ? `<div class="tree-children">${node.children.map(renderNode).join("")}</div>` : ""}
      </div>`;
  };
  host.innerHTML = TOPIC_TREE.length ? TOPIC_TREE.map(n => renderNode(n)).join("")
    : '<p class="tree-empty">还没有观点。点右上角「新建观点」开始。</p>';

  $$(".tree-row", host).forEach(row => {
    row.addEventListener("click", (e) => {
      const tid = parseInt(row.dataset.tid);
      const node = findTopicNode(TOPIC_TREE, tid);
      if (!node) return;
      const act = e.target.closest("[data-act]");
      if (act) {
        e.stopPropagation();
        if (act.dataset.act === "addf") createTopicNode("folder", tid);
        else if (act.dataset.act === "addt") createTopicNode("topic", tid);
        else if (act.dataset.act === "move") openTopicMoveModal(node);
        else if (act.dataset.act === "del") deleteTopicNode(node);
        return;
      }
      if (node.children && node.children.length) {
        TOPIC_OPEN[tid] = !(TOPIC_OPEN[tid] !== false);
      }
      if (node.kind === "topic") openTopicFile(node);
      else onTopicNodeClick(node);
    });
  });
}

async function deleteTopicNode(node) {
  const label = node.kind === "topic" ? "观点" : "文件夹";
  const extra = node.children && node.children.length ? "（含其所有子级）" : "";
  if (!confirm(`删除${label}「${node.name}」${extra}？\n它下面的条目会变回「未归属 · 游民」（思考本身还在论文里），观点层级结构删除后不可恢复。`)) return;
  try {
    // 删除前抓快照（子树结构 + 各观点名下条目），供 Ctrl+Z 重建
    const snap = await snapshotTopicSubtree(node.id);
    const r = await req("DELETE", "/api/topic_nodes?id=" + node.id);
    // 撤销按快照重建子树（节点会拿到新 id），redo 删除目标随之更新
    let redoNodeId = node.id;
    const entry = {
      label: "删除" + label + "「" + node.name + "」",
      undo: async () => {
        const idMap = await rebuildTopicSubtree(snap);
        redoNodeId = idMap[node.id];
      },
      redo: async () => { await req("DELETE", "/api/topic_nodes?id=" + redoNodeId); },
    };
    pushUndoEntry(entry);
    toast(r.message || "已删除");
    // 当前打开/选中的节点被删掉就清空右侧
    const stillThere = (n) => n && findTopicNode(TOPIC_TREE, n.id);
    if (TOPIC_CURRENT_FILE && !stillThere(TOPIC_CURRENT_FILE)) {
      TOPIC_CURRENT_FILE = null;
      $("#topic-notes").innerHTML = "";
      $("#topic-file-title").textContent = "未选择文件";
      $("#topic-add-note-btn").disabled = true;
      $("#topic-crumbs").textContent = "";
    }
    if (TOPIC_CURRENT_PARENT && !stillThere(TOPIC_CURRENT_PARENT)) TOPIC_CURRENT_PARENT = null;
    await loadTopicTree();
  } catch (e) { toast(e.message, true); }
}

function onTopicNodeClick(n) {
  if (n.kind === "topic") {
    openTopicFile(n);
    return;
  }
  TOPIC_CURRENT_PARENT = n;
  TOPIC_CURRENT_FILE = null;
  renderTopicTree();
  $("#topic-crumbs").textContent = n.name;
  $("#topic-file-title").textContent = n.name;
  $("#topic-hint").hidden = false;
  $("#topic-hint").textContent = "这是文件夹，可在其中新建子文件夹或观点；点左侧某个观点即可查看它引用的文献条目。";
  $("#topic-notes").innerHTML = "";
  $("#topic-add-note-btn").disabled = true;
  $("#add-topic-folder-btn").disabled = false;
}

async function openTopicFile(n) {
  try {
    const d = await req("GET", "/api/topics/file?id=" + n.id);
    const f = d.file;
    TOPIC_CURRENT_FILE = f;
    TOPIC_CURRENT_PARENT = null;
    renderTopicTree();
    $("#topic-crumbs").textContent = f.path_name || f.name;
    $("#topic-file-title").textContent = f.name;
    $("#topic-hint").hidden = true;
    $("#topic-add-note-btn").disabled = false;
    renderTopicNotes(f);
  } catch (e) {
    toast("加载观点文件失败", true);
  }
}

function renderTopicNotes(f) {
  const host = $("#topic-notes");
  if (!host) return;
  host.innerHTML = "";
  if (!f.notes || !f.notes.length) {
    host.innerHTML = '<p class="tree-empty">这个观点下还没有条目。点右上角「新增条目」开始记录。</p>';
    return;
  }
  const refresh = () => { if (TOPIC_CURRENT_FILE) return openTopicFile(TOPIC_CURRENT_FILE); };
  f.notes.forEach((n, i) => {
    let card;
    try {
      // 注意：renderViewNoteCard 返回的是 HTML 字符串（renderPaperView 里拼 innerHTML 用的），
      // 这里要插来源标签 / 绑定按钮，必须先转成真正的 DOM 元素，否则 insertBefore 直接 TypeError
      // 观点视图不显示卡片序号（#N），避免「这个 2 是什么」的困惑；fullscreen 仍用 i+1
      const t = document.createElement("template");
      t.innerHTML = renderViewNoteCard(n, null).trim();
      card = t.content.firstElementChild;
      if (!card) throw new Error("empty card");
    } catch (e) {
      card = document.createElement("div");
      card.className = "note-card";
      card.textContent = n.content || ("（条目 #" + n.id + " 渲染失败）");
    }
    if (n.paper) {
      // 来源文献胶囊：英文为主行（平时读英文认得出是哪篇），中文放 title；
      // 醒目大按钮，点击直接跳到这篇论文的 View 页
      const en = (n.paper.title_en || "").trim();
      const zh = (n.paper.title_zh || "").trim();
      const main = en || zh || "未命名";
      const sub = (en && zh) ? zh : "";
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "assign-chip assign-chip--source";
      chip.title = sub ? "来源：" + sub + "（点击打开这篇论文）" : "点击打开这篇论文";
      chip.innerHTML = "<svg><use href=\"#i-doc\"/></svg><span>" + esc(main) + "</span>";
      chip.addEventListener("click", () => jumpToPaper(n.paper.id));
      card.insertBefore(chip, card.firstChild);
    }
    // 绑定卡片上的全部操作按钮 —— 与论文 View 页同一套行为，缺一个就是点不动
    const paperId = n.paper_id || (n.paper && n.paper.id);
    $$(".pv-card__action[data-action]", card).forEach(btn => {
      const act = btn.dataset.action;
      if (act === "add") {
        // 在当前观点文件里续写一条，来源沿用这条思考的论文
        btn.onclick = () => openNoteComposeEditor({
          paperId,
          topicFileId: TOPIC_CURRENT_FILE ? TOPIC_CURRENT_FILE.id : null,
        });
      } else if (act === "delete") {
        btn.onclick = async () => {
          if (!confirm("删除这条思考？提示条里点「撤销」可立即找回。")) return;
          try {
            await req("DELETE", "/api/notes?id=" + n.id);
            pushUndo("删除思考",
              async () => { await restoreNotesByIds([n.id]); },
              async () => { await req("DELETE", "/api/notes?id=" + n.id); });
            toastAction("已删除 1 条思考", "撤销", () => undoDeleteNotes([n.id], refresh));
            await refresh();
          } catch (e) { toast(e.message, true); }
        };
      } else if (act === "edit") {
        btn.onclick = () => openNoteComposeEditor({ note: n });
      } else if (act === "assign") {
        btn.onclick = () => openNoteAssignModal(n, refresh);
      } else if (act === "arrange") {
        btn.onclick = () => {
          if (state.arrange && state.arrange.noteId === n.id) exitArrangeMode();
          else enterArrangeMode(card, n);
        };
      } else if (act === "fullscreen") {
        btn.onclick = () => openNoteFullscreen(n, i + 1);
      }
    });
    host.appendChild(card);
  });
}

/* ---- 移动节点：目标选择弹窗（论文视图 / 观点视图共用骨架） ---- */
function openMoveTargetModal(opts) {
  const rows = opts.options.map((o, i) => `
    <div class="picker-row" data-mi="${i}"><b>${esc(o.label)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ""}</div>`).join("");
  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">MOVE</p>
    <h3>${esc(opts.title)}</h3>
    <p class="modal-hint">点选一个目标位置，再点「确定」。它自己和它的子级已从列表里隐藏，不会形成环。</p>
    <div class="picker-list" id="move-target-list" style="max-height:340px;">${rows}</div>
    <div class="modal-actions">
      <button class="scan-button scan-button--ghost" id="move-cancel" type="button">取消</button>
      <button class="scan-button" id="move-ok" type="button" disabled><svg style="width:14px;height:14px;"><use href="#i-check"/></svg><span>确定</span></button>
    </div>`, "modal--wide");
  $("#m-close").onclick = closeModal;
  $("#move-cancel").onclick = closeModal;
  let picked = null;
  const list = $("#move-target-list");
  const okBtn = $("#move-ok");
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".picker-row");
    if (!row) return;
    $$(".picker-row", list).forEach(r => r.classList.remove("is-chosen"));
    row.classList.add("is-chosen");
    picked = opts.options[parseInt(row.dataset.mi)];
    okBtn.disabled = false;
  });
  okBtn.addEventListener("click", () => { if (picked) opts.onPick(picked); });
}

/* 观点视图：移动文件夹 / 观点到别的文件夹或顶层 */
function openTopicMoveModal(node) {
  const banned = new Set();
  (function collect(n) { banned.add(n.id); (n.children || []).forEach(collect); })(node);
  const options = [{ key: "root", label: "（顶层）", sub: "移动后挂在观点树最外层" }];
  (function walk(ns, prefix) {
    (ns || []).forEach(n => {
      if (n.kind !== "folder") return;
      const path = prefix ? prefix + " / " + n.name : n.name;
      if (!banned.has(n.id)) options.push({ key: "f" + n.id, label: path, sub: "文件夹" });
      walk(n.children || [], path);
    });
  })(TOPIC_TREE, "");
  openMoveTargetModal({
    title: "移动「" + node.name + "」",
    options,
    onPick: async (picked) => {
      const parent_id = picked.key === "root" ? null : parseInt(picked.key.slice(1));
      try {
        const oldParentId = node.parent_id;
        await req("POST", "/api/topic_nodes/move", { id: node.id, parent_id });
        pushUndo("移动「" + node.name + "」",
          async () => { await req("POST", "/api/topic_nodes/move", { id: node.id, parent_id: oldParentId }); },
          async () => { await req("POST", "/api/topic_nodes/move", { id: node.id, parent_id }); });
        closeModal();
        toast("已移动");
        await loadTopicTree();
      } catch (e) { toast(e.message, true); }
    },
  });
}

/* 论文视图：移动文件夹到别的项目 / 文件夹（子树整体搬家，论文跟随） */
async function openFolderMoveModal(fid) {
  let all;
  try {
    all = await req("GET", "/api/folders/all");
  } catch (e) { toast("加载项目列表失败", true); return; }
  const node = findFolder(state.folderTree, fid);
  if (!node) { toast("找不到该文件夹", true); return; }
  const banned = new Set();
  (function collect(n) { banned.add(n.id); (n.children || []).forEach(collect); })(node);
  const options = [];
  (all.projects || []).forEach(p => {
    options.push({ key: "p" + p.project_id, label: p.project_name + " · 顶层", sub: "项目根目录", projectId: p.project_id, parentId: null });
    (function walk(ns, prefix) {
      (ns || []).forEach(f => {
        if (banned.has(f.id)) return; // 自己的子树整体剪掉，防环
        const path = prefix ? prefix + " / " + f.name : f.name;
        options.push({ key: "f" + f.id, label: p.project_name + " / " + path, sub: "文件夹", projectId: p.project_id, parentId: f.id });
        walk(f.children || [], path);
      });
    })(p.folders || [], "");
  });
  openMoveTargetModal({
    title: "移动「" + node.name + "」",
    options,
    onPick: async (picked) => {
      try {
        const node = findFolder(state.folderTree, fid);
        // 节点上不一定带 project_id，兜底用当前项目
        const oldProjectId = (node && node.project_id) || state.currentProjectId;
        const oldParentId = node ? node.parent_id : null;
        await req("POST", "/api/folders/move", { id: fid, project_id: picked.projectId, parent_id: picked.parentId });
        pushUndo("移动文件夹「" + (node ? node.name : "") + "」",
          async () => { await req("POST", "/api/folders/move", { id: fid, project_id: oldProjectId, parent_id: oldParentId }); },
          async () => { await req("POST", "/api/folders/move", { id: fid, project_id: picked.projectId, parent_id: picked.parentId }); });
        closeModal();
        toast("已移动（子文件夹与论文一并搬过去了）");
        await loadProjects();
        await loadTree(state.currentProjectId);
      } catch (e) { toast(e.message, true); }
    },
  });
}

async function createTopicNode(kind, parentId) {
  const label = kind === "topic" ? "观点" : "文件夹";
  // 写明会建在哪，不让用户猜：选中文件夹→建里面，否则→顶层
  const parentNode = parentId ? findTopicNode(TOPIC_TREE, parentId) : null;
  const where = parentNode ? "（建在「" + parentNode.name + "」中）" : "（建在顶层）";
  const name = prompt("新建" + label + where + "，请输入名称：");
  if (!name || !name.trim()) return;
  try {
    const nr = await req("POST", "/api/topic_nodes", { kind: kind, name: name.trim(), parent_id: parentId });
    // 撤销新建 = 删掉这个节点（节点下还没条目，直接删无副作用）；重做 = 原样重建
    // 重做会换新 id，用可变量让撤销始终指向最新 id
    let currentNodeId = nr.id;
    pushUndo("新建" + label + "「" + name.trim() + "」",
      async () => { await req("DELETE", "/api/topic_nodes?id=" + currentNodeId); },
      async () => {
        const rr = await req("POST", "/api/topic_nodes", { kind: kind, name: name.trim(), parent_id: parentId });
        currentNodeId = rr.id;
      });
    toast("已创建" + label);
    if (parentId) TOPIC_OPEN[parentId] = true; // 新建的子级要能立刻看到
    loadTopicTree();
  } catch (e) {
    toast("创建失败：" + ((e && e.error) || "未知错误"), true);
  }
}

/* 观点视图新增条目：第一步强制先选来源文献，选完才进入编辑器。
   布局：左侧 项目→文件夹 树形导航（论文是按项目组织的，选文献也该这样，不能一上来平铺几千篇），
   右侧论文列表。论文同时给英文和中文标题 —— 平时读的是英文，只给中文反而认不出是哪篇。
   还可以就地导入一篇新论文（拖 PDF / 手填），导入完回到本选择器。 */
async function openTopicNoteComposer(topicFileId) {
  const load = async (q) => {
    const d = await req("GET", "/api/papers/search?q=" + encodeURIComponent(q || ""));
    return d.papers || [];
  };
  let papers = [];
  try {
    papers = await load("");
  } catch (e) {
    toast("加载论文列表失败", true);
    return;
  }

  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <p class="eyebrow">SOURCE PAPER</p>
    <h3>选择来源文献</h3>
    <p class="modal-hint">观点条目必须绑定到库内已有论文，保证条条可追溯、可跳转。左侧按项目 / 文件夹定位，也可以直接搜索，或导入一篇新论文。</p>
    <div class="picker-search"><svg><use href="#i-search"/></svg>
      <input type="search" id="topic-paper-q" placeholder="搜索标题（中英均可）/ 期刊 / 作者">
    </div>
    <div class="picker-layout">
      <div class="picker-tree" id="topic-paper-tree"></div>
      <div class="picker-list" id="topic-paper-list"></div>
    </div>
    <div class="modal-actions">
      <button class="scan-button scan-button--ghost" id="topic-import" type="button"><svg style="width:14px;height:14px;"><use href="#i-upload"/></svg><span>导入新论文</span></button>
      <button class="scan-button scan-button--ghost" id="topic-picker-cancel" type="button">取消</button>
      <button class="scan-button" id="topic-picker-ok" type="button" disabled><svg style="width:14px;height:14px;"><use href="#i-check"/></svg><span>确定</span></button>
    </div>`, "modal--wide");
  $("#m-close").onclick = closeModal;

  let current = { projectId: null, folderId: null }; // null = 全部
  let chosenPaper = null; // 高亮选中的论文，点「确定」才真正进入编辑器
  const list = $("#topic-paper-list");
  const treeHost = $("#topic-paper-tree");
  const q = $("#topic-paper-q");
  const okBtn = $("#topic-picker-ok");

  /* 左侧树：从论文数据聚合出 项目 → 文件夹（没有论文的空文件夹不出现） */
  const buildNav = () => {
    const byProject = new Map();
    papers.forEach(p => {
      if (!byProject.has(p.project_id)) byProject.set(p.project_id, { id: p.project_id, name: p.project_name || "（未命名项目）", folders: new Map() });
      const proj = byProject.get(p.project_id);
      const fid = p.folder_id;
      if (!proj.folders.has(fid)) proj.folders.set(fid, { id: fid, name: p.folder_name || "（未命名文件夹）", count: 0 });
      proj.folders.get(fid).count++;
    });
    const row = (icon, label, count, active, onclick, indent) => {
      const el = document.createElement("div");
      el.className = "tree-row" + (active ? " is-active" : "");
      if (indent) el.style.paddingLeft = indent + "px";
      el.innerHTML = `<svg class="folder-ico"><use href="${icon}"/></svg>`
        + `<span class="tree-name">${esc(label)}</span>`
        + `<span class="tree-count">${count}</span>`;
      el.addEventListener("click", onclick);
      return el;
    };
    treeHost.innerHTML = "";
    treeHost.appendChild(row("#i-grid", "全部论文", papers.length,
      current.projectId === null, () => { current = { projectId: null, folderId: null }; buildNav(); paintList(); }));
    Array.from(byProject.values()).sort((a, b) => a.name.localeCompare(b.name, "zh")).forEach(proj => {
      const total = Array.from(proj.folders.values()).reduce((s, f) => s + f.count, 0);
      treeHost.appendChild(row("#i-folder", proj.name, total,
        current.projectId === proj.id && current.folderId === null,
        () => { current = { projectId: proj.id, folderId: null }; buildNav(); paintList(); }));
      Array.from(proj.folders.values())
        .sort((a, b) => a.name.localeCompare(b.name, "zh"))
        .forEach(f => {
          treeHost.appendChild(row("#i-folder", f.name, f.count,
            current.folderId === f.id,
            () => { current = { projectId: proj.id, folderId: f.id }; buildNav(); paintList(); }, 26));
        });
    });
  };

  /* 右侧列表：英文标题为主行，中文标题（若有）放副行 —— 平时读的是英文，只给中文认不出是哪篇 */
  const paperRow = (p) => {
    const en = (p.title_en || "").trim();
    const zh = (p.title_zh || "").trim();
    const main = en || zh || "（无标题）";
    const sub = (en && zh ? zh : "") + (en && zh ? " · " : "")
      + [p.project_name, p.folder_name].filter(Boolean).join(" / ")
      + (p.journal ? " · " + p.journal : "");
    const row = document.createElement("div");
    row.className = "picker-row";
    row.innerHTML = `<b title="${esc(main)}">${esc(main)}</b><small>${esc(sub)}</small>`;
    row.addEventListener("click", () => {
      // 点击不立即进编辑器，先高亮选中；点底部「确定」才进
      list.querySelectorAll(".picker-row.is-chosen").forEach(el => el.classList.remove("is-chosen"));
      row.classList.add("is-chosen");
      chosenPaper = p;
      okBtn.disabled = false;
      okBtn.querySelector("span").textContent = "确定 · " + (en || zh || "").slice(0, 22);
    });
    return row;
  };
  const paintList = () => {
    const kw = q.value.trim().toLowerCase();
    let rows = papers;
    if (kw) {
      rows = papers.filter(p => [p.title_en, p.title_zh, p.journal, p.authors]
        .some(v => (v || "").toLowerCase().includes(kw)));
    } else {
      if (current.folderId != null) rows = papers.filter(p => p.folder_id === current.folderId);
      else if (current.projectId != null) rows = papers.filter(p => p.project_id === current.projectId);
    }
    rows = rows.slice().sort((a, b) => (a.title_en || a.title_zh || "").localeCompare(b.title_en || b.title_zh || ""));
    list.innerHTML = "";
    if (!rows.length) {
      list.innerHTML = '<p class="tree-empty">'
        + (kw ? "没有匹配的论文，换个关键词，或点左下角「导入新论文」"
              : "这个位置还没有论文。换左侧其它文件夹，或点「导入新论文」")
        + "</p>";
      return;
    }
    rows.forEach(p => list.appendChild(paperRow(p)));
  };

  buildNav();
  paintList();

  let timer = null;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => paintList(), 180);
  });
  $("#topic-picker-cancel").addEventListener("click", closeModal);
  okBtn.addEventListener("click", () => {
    if (!chosenPaper) { toast("先在右侧选一篇来源文献"); return; }
    const p = chosenPaper;
    closeModal();
    openNoteComposeEditor({ paperId: p.id, topicFileId });
  });
  // 就地导入新论文：保存成功后重新打开本选择器（论文会出现在列表里）
  $("#topic-import").addEventListener("click", () => {
    openPaperModal(null, async () => {
      try {
        const d = await req("GET", "/api/papers/search?q=");
        papers = d.papers || [];
      } catch (e) { /* 下次打开会重新加载 */ }
      openTopicNoteComposer(topicFileId);
    });
  });
}

/* ============================================================
   论文视图：思考按观点分组 + 「被 N 个观点引用」抬头 + 归属菜单
   ============================================================ */

/* 顶部胶囊条：这篇论文被哪些观点引用了，点了直接跳过去 */
function renderTopicRefsBar(p) {
  const refs = p.topic_refs || [];
  if (!refs.length) return "";
  return `
    <div class="topic-refs-bar" id="topic-refs-bar">
      <span class="topic-refs-bar__label">被 ${refs.length} 个观点引用</span>
      ${refs.map(r => `
        <button class="topic-ref-chip" data-file="${r.file_id}" type="button" title="跳到观点视图打开「${esc(r.path || "")}」">
          <svg><use href="#i-flag"/></svg><span>${esc(r.path || "（观点）")}</span><b>${r.c}</b>
        </button>`).join("")}
    </div>`;
}

/* 思考列表按所属观点文件分组；未归属的单列一区「游民」 */
function renderNotesGrouped(notes) {
  if (!notes.length) return "";
  const groups = [];
  const byFile = new Map();
  const nomads = [];
  notes.forEach(n => {
    if (n.topic_file_id) {
      if (!byFile.has(n.topic_file_id)) {
        byFile.set(n.topic_file_id, {
          fileId: n.topic_file_id,
          path: n.topic_path || n.topic_name || "（观点）",
          items: [],
        });
      }
      byFile.get(n.topic_file_id).items.push(n);
    } else {
      nomads.push(n);
    }
  });
  // 后端已按「观点文件创建时间」排好序，Map 的插入顺序即分组顺序
  byFile.forEach(g => groups.push(g));
  return groups.map(g => `
    <div class="note-group" data-file="${g.fileId}">
      <div class="note-group__head">
        <svg><use href="#i-flag"/></svg>
        <span class="note-group__path" title="${esc(g.path)}">${esc(g.path)}</span>
        <b>${g.items.length} 条</b>
        <button class="note-group__jump" data-file="${g.fileId}" type="button" title="跳到观点视图">跳转</button>
      </div>
      ${g.items.map(n => renderNoteCard(n)).join("")}
    </div>`).join("") + (nomads.length ? `
    <div class="note-group note-group--nomad">
      <div class="note-group__head">
        <svg><use href="#i-doc"/></svg>
        <span class="note-group__path">未归属观点 · 游民</span>
        <b>${nomads.length} 条</b>
      </div>
      ${nomads.map(n => renderNoteCard(n)).join("")}
    </div>` : "");
}

/* 从论文抽屉 / 分组头跳到观点视图并打开指定文件 */
async function jumpToTopicFile(fileId) {
  closeDrawer();
  setViewMode("topics");
  await loadTopicTree();
  const node = findTopicNode(TOPIC_TREE, fileId);
  if (node) await openTopicFile(node);
  else toast("找不到该观点文件", true);
}

/* 反向：从观点视图跳到某篇论文的 View 页 */
async function jumpToPaper(pid) {
  setViewMode("projects");
  await openPaperView(pid);
}

function findTopicNode(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findTopicNode(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

/* ---- 归属操作菜单 ---- */

/* 把观点树展平成「文件」列表（带完整路径），供归属选择器使用 */
function flattenTopicFiles(nodes, prefix) {
  let out = [];
  for (const n of nodes || []) {
    const path = prefix ? prefix + " / " + n.name : n.name;
    if (n.kind === "topic") out.push({ id: n.id, name: n.name, path: path, entry_count: n.entry_count || 0 });
    if (n.children && n.children.length) out = out.concat(flattenTopicFiles(n.children, path));
  }
  return out;
}

async function loadTopicFilesFlat() {
  try {
    const d = await req("GET", "/api/topics/tree");
    TOPIC_TREE = d.topics || [];
    return flattenTopicFiles(TOPIC_TREE, "");
  } catch (e) {
    return [];
  }
}

/* 逐条思考的归属菜单：加入观点 / 移到别的观点 / 清除归属变游民 */
async function openNoteAssignModal(note, onDone) {
  const files = await loadTopicFilesFlat();
  const current = note.topic_path || (note.topic_file_id ? "（观点）" : "");
  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <div class="modal-head">
      <h3>这条思考归属到哪个观点</h3>
      <p>当前：${current ? `<b>${esc(current)}</b>` : '<b style="color:var(--copper-700);">未归属 · 游民</b>'}。一条思考最多归属一个观点文件。</p>
    </div>
    ${files.length ? `
      <div class="picker-search"><svg><use href="#i-search"/></svg>
        <input type="search" id="assign-q" placeholder="搜索观点文件">
      </div>
      <div class="picker-list" id="assign-list"></div>
      <div class="modal-actions">
        <button class="scan-button scan-button--ghost" id="assign-clear" type="button" ${note.topic_file_id ? "" : "disabled"}>清除归属</button>
        <button class="scan-button" id="assign-save" type="button" disabled>设为归属</button>
      </div>`
    : `<p class="dup-hint">还没有观点「文件」。请先切到观点视图：新建一个观点 → 在其中新建「文件」，再回来归属。</p>
       <div class="modal-actions"><button class="scan-button scan-button--ghost" id="m-close2" type="button">知道了</button></div>`}
  `);

  $("#m-close").onclick = closeModal;
  const close2 = $("#m-close2");
  if (close2) close2.onclick = closeModal;
  if (!files.length) return;

  let chosen = note.topic_file_id || null;
  const list = $("#assign-list");
  const saveBtn = $("#assign-save");

  const paint = (kw) => {
    const k = (kw || "").trim().toLowerCase();
    const hits = files.filter(f => !k || f.path.toLowerCase().includes(k));
    list.innerHTML = hits.length ? hits.map(f => `
      <div class="picker-row${f.id === chosen ? " is-chosen" : ""}" data-id="${f.id}">
        <b>${esc(f.path)}</b>
        <small>${f.entry_count} 条条目${f.id === note.topic_file_id ? " · 当前归属" : ""}</small>
      </div>`).join("") : `<p class="tree-empty">没有匹配的观点文件</p>`;
    $$(".picker-row", list).forEach(row => {
      row.onclick = () => {
        chosen = Number(row.dataset.id);
        saveBtn.disabled = chosen === note.topic_file_id;
        paint($("#assign-q").value);
      };
    });
  };
  paint("");
  $("#assign-q").addEventListener("input", (e) => paint(e.target.value));

  saveBtn.onclick = async () => {
    if (!chosen) { toast("请先选一个观点文件"); return; }
    try {
      const oldTopic = note.topic_file_id;
      await req("POST", "/api/notes/assign", { note_id: note.id, topic_file_id: chosen });
      pushUndo("调整条目归属",
        async () => { await req("POST", "/api/notes/assign", { note_id: note.id, topic_file_id: oldTopic }); },
        async () => { await req("POST", "/api/notes/assign", { note_id: note.id, topic_file_id: chosen }); });
      closeModal();
      toast("已归属到观点");
      if (onDone) await onDone();
    } catch (e) { toast(e.message, true); }
  };
  const clearBtn = $("#assign-clear");
  if (clearBtn && note.topic_file_id) {
    clearBtn.onclick = async () => {
      try {
        const oldTopic = note.topic_file_id;
        await req("POST", "/api/notes/assign", { note_id: note.id, topic_file_id: null });
        pushUndo("清除条目归属",
          async () => { await req("POST", "/api/notes/assign", { note_id: note.id, topic_file_id: oldTopic }); },
          async () => { await req("POST", "/api/notes/assign", { note_id: note.id, topic_file_id: null }); });
        closeModal();
        toast("已清除归属，这条变成游民（思考本身没删）");
        if (onDone) await onDone();
      } catch (e) { toast(e.message, true); }
    };
  }
}

/* ============================================================
   共享入口：把库里已有的论文引到当前文件夹（不重复导入）
   ============================================================ */
async function openSharePaperModal() {
  let papers = [];
  try {
    const d = await req("GET", "/api/papers/search?q=");
    papers = d.papers || [];
  } catch (e) {
    toast("加载论文列表失败", true);
    return;
  }
  if (!papers.length) {
    toast("库里还没有论文，先导入一篇吧", true);
    return;
  }
  let fid = state.currentFolderId;
  if (!fid) {
    await ensureRootFolder();
    fid = state.currentFolderId;
  }
  const folderName = (state.currentFolderPath || []).map(x => x.name).join(" / ") || "当前文件夹";

  openModal(`
    <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
    <div class="modal-head">
      <h3>导入已有论文</h3>
      <p>从库里选一篇已经存在的论文，引用到「${esc(folderName)}」。不会产生第二条记录，条目和观点归属都跟着走。</p>
    </div>
    <div class="picker-search"><svg><use href="#i-search"/></svg>
      <input type="search" id="share-q" placeholder="搜索标题 / 期刊 / 作者">
    </div>
    <div class="picker-list" id="share-list"></div>
    <div class="modal-actions">
      <button class="scan-button" id="share-save" type="button" disabled>引用到当前文件夹</button>
    </div>`);

  $("#m-close").onclick = closeModal;
  let chosen = null;
  const list = $("#share-list");
  const saveBtn = $("#share-save");

  const paint = (kw) => {
    const k = (kw || "").trim().toLowerCase();
    const hits = papers.filter(p =>
      !k || [p.title_en, p.title_zh, p.journal, p.authors].some(v => (v || "").toLowerCase().includes(k)));
    list.innerHTML = hits.length ? hits.map(p => `
      <div class="picker-row${p.id === chosen ? " is-chosen" : ""}" data-id="${p.id}">
        <b>${esc(p.title_zh || p.title_en || "（无标题）")}</b>
        <small>${esc(p.project_name || "")}${p.folder_name ? " / " + esc(p.folder_name) : ""} · ${p.note_count || 0} 条思考${p.doi ? " · " + esc(p.doi) : ""}</small>
      </div>`).join("") : `<p class="tree-empty">没有匹配的论文</p>`;
    $$(".picker-row", list).forEach(row => {
      row.onclick = () => {
        chosen = Number(row.dataset.id);
        saveBtn.disabled = false;
        paint($("#share-q").value);
      };
    });
  };
  paint("");
  $("#share-q").addEventListener("input", (e) => paint(e.target.value));

  saveBtn.onclick = async () => {
    if (!chosen) return;
    try {
      await req("POST", "/api/papers/share", { paper_id: chosen, folder_id: fid });
      pushUndo("共享论文到文件夹",
        async () => { await req("DELETE", "/api/papers/unshare?paper_id=" + chosen + "&folder_id=" + fid); },
        async () => { await req("POST", "/api/papers/share", { paper_id: chosen, folder_id: fid }); });
      closeModal();
      toast("已引用库内已有论文");
      await loadTree();
      await loadPapers();
      await loadProjects();
    } catch (e) { toast(e.message, true); }
  };
}

/* 分组头上的「跳转」按钮 */
document.addEventListener("click", (e) => {
  const jump = e.target.closest(".note-group__jump");
  if (jump) jumpToTopicFile(parseInt(jump.dataset.file));
});
