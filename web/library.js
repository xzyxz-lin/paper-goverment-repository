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

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
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
  }

  // 在 VIEW 全屏浏览页隐藏 topbar 的「回收站」「新建项目」，避免干扰阅读
  const hideTopActions = view === "paper-view";
  $("#recycle-open-btn").hidden = hideTopActions;
  $("#new-project-btn").hidden = hideTopActions;
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

    <div id="notes-list">
      ${notes.map(n => renderNoteCard(n)).join("")}
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

  // 已有笔记的编辑 / 删除
  $$("#notes-list .note-card__edit").forEach(btn => btn.addEventListener("click", () => {
    const nid = parseInt(btn.dataset.note);
    const note = (p.notes || []).find(n => n.id === nid);
    if (note) openNoteComposeEditor({ note });
  }));
  $$("#notes-list .note-card__del").forEach(btn => btn.addEventListener("click", () => deleteNote(parseInt(btn.dataset.note), p.id)));

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
  const re = /\[\[img:(\d+)\]\]/g;
  let html = "";
  let last = 0;
  let m;
  const used = new Set();
  const flushText = (txt) => {
    if (txt && txt.trim()) html += `<p class="note-text">${esc(txt).replace(/\n/g, "<br>")}</p>`;
  };
  while ((m = re.exec(content)) !== null) {
    flushText(content.slice(last, m.index));
    const idx = parseInt(m[1]);
    const img = images[idx];
    if (img) {
      html += `<div class="note-img-inline"><img src="/assets/${encodeURI(img.rel_path)}" alt="截图" loading="lazy"></div>`;
      used.add(idx);
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
      else if (ch.nodeName === "DIV" || ch.nodeName === "P") { walk(ch); content += "\n"; }
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
  if (!confirm("删除这条思考？删除后可在回收站保留 7 天。")) return;
  await req("DELETE", "/api/notes?id=" + nid);
  toast("已删除");
  await refreshPaper(paperId);
}

async function deleteSelectedNotes(paperId) {
  const ids = Array.from(state.selNotes);
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 条思考？删除后可在回收站保留 7 天。`)) return;
  await req("DELETE", "/api/notes?ids=" + ids.join(","));
  state.selNotes.clear();
  toast(`已删除 ${ids.length} 条思考`);
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
    list.innerHTML = notes.map((n, idx) => renderViewNoteCard(n, idx + 1)).join("");
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
  if (!confirm("删除这条思考？删除后可在历史版本中保留 7 天。")) return;
  await req("DELETE", "/api/notes?id=" + note.id);
  toast("已删除");
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
  state.arrange = { noteId: note.id, blocks, dirty: false, selectedKey: null };
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
  const card = document.querySelector(`.pv-card[data-note-id="${a.noteId}"]`);
  if (card) {
    card.classList.remove("is-arranging");
    $$(".pv-block", card).forEach(el => {
      el.draggable = false;
      el.classList.remove("is-dragging", "is-insert-before", "is-insert-after", "is-selected");
    });
    const btn = card.querySelector(".pv-card__action[data-action='arrange'] span");
    if (btn) btn.textContent = "排版";
  }
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

// 拖拽插入：把 dragKey 块移到 targetKey 块的前/后，列属性跟着块走
async function insertArrangeBlock(dragKey, targetKey, before, card) {
  const a = state.arrange;
  if (!a) return;
  const from = a.blocks.findIndex(b => b.key === dragKey);
  let to = a.blocks.findIndex(b => b.key === targetKey);
  if (from < 0 || to < 0) return;
  const [moved] = a.blocks.splice(from, 1);
  if (from < to) to--; // 删除后目标索引前移
  a.blocks.splice(before ? to : to + 1, 0, moved);
  a.blocks.forEach((b, i) => { b.order = i; });
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
  const note = (state._viewPaper?.notes || []).find(n => n.id === a.noteId);
  if (!note) return;
  const layout = arrangeLayout();
  const body = card.querySelector(".pv-card__body");
  body.innerHTML = renderViewNoteBlocks({ ...note, layout });
  layoutViewImages(body);
  bindArrangeDrag(card);
  try {
    await req("PUT", "/api/notes/layout", { id: note.id, layout });
    note.layout = layout; // 同步内存，后续重渲染保持新排版
  } catch (err) {
    toast("排版保存失败：" + (err && err.message || err));
  }
}

async function deleteSelectedViewNotes(paperId) {
  const ids = Array.from(state.selViewNotes);
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 条思考？删除后可在历史版本中保留 7 天。`)) return;
  await req("DELETE", "/api/notes?ids=" + ids.join(","));
  state.selViewNotes.clear();
  toast(`已删除 ${ids.length} 条思考`);
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
      else if (ch.nodeName === "DIV" || ch.nodeName === "P") { walk(ch); content += "\n"; }
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

function openNoteFullscreen(n) {
  const overlay = $("#note-fullscreen");
  const content = $("#note-fullscreen-content");
  fullscreenScaleIndex = 1; // 默认标准大小
  content.innerHTML = `
    ${flagBadge(n)}
    <div class="pv-card__head" style="border-color:rgba(255,255,255,.12);">
      <span class="pv-card__time" style="color:rgba(255,255,255,.7);">${esc((n.created_at || "").replace("T", " ").slice(0, 16))}</span>
      <span class="pv-card__index" style="color:rgba(255,255,255,.55);">#${esc(String(state._viewPaper?.notes?.indexOf(n) + 1 || ""))}</span>
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
          <button class="pv-card__action" data-action="arrange" type="button" title="拖拽排版：按住块拖到另一块上对换位置"><svg><use href="#i-layout"/></svg><span>排版</span></button>
          <button class="pv-card__action" data-action="fullscreen" type="button" title="全屏查看"><svg><use href="#i-image"/></svg><span>全屏</span></button>
          <span class="pv-card__index">#${idx}</span>
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
  const re = /\[\[img:(\d+)\]\]/g;
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
    const idx = parseInt(m[1]);
    const img = images[idx];
    if (img) {
      blocks.push({ type: "image", key: `img_${img.id}`, image: img, image_id: img.id });
      used.add(idx);
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

function openNoteComposeEditor(opts) {
  const { paperId, note } = opts || {};
  const isEdit = !!note;
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
    const secHtml = sections.map(sec => sectionHtml(sec)).join("");
    openModal(`
      <button class="icon-button" id="m-close" type="button" aria-label="关闭"><svg><use href="#i-close"/></svg></button>
      <p class="eyebrow">${isEdit ? "EDIT NOTE" : "NEW NOTE"}</p>
      <h3>${isEdit ? "编辑思考" : "新增思考"}</h3>
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
          <div class="layout-block__edit" contenteditable="true" data-key="${b.key}">${esc(b.text).replace(/\n/g, "<br>")}</div>
          <button class="layout-block__del" data-key="${b.key}" type="button" title="删除此块">×</button>
        </div>`;
      }
      const src = b.data ? `data:image/${b.ext};base64,${b.data}` : `/assets/${encodeURI(b.rel_path)}`;
      return `<div class="layout-block layout-block--image" draggable="true" data-key="${b.key}">
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
          content += (content ? "\n" : "") + t;
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
        const nd = await req("POST", "/api/notes", { paper_id: paperId, content });
        const nid = nd.id;
        for (const img of newImages) {
          await req("POST", "/api/notes/images", { note_id: nid, data: img.data, ext: img.ext });
        }
        await req("PUT", "/api/notes/layout", { id: nid, layout });
        toast("已新增思考");
      } else {
        await req("PUT", "/api/notes", { id: note.id, content, images: newImages, flagged });
        await req("PUT", "/api/notes/layout", { id: note.id, layout });
        toast("已保存修改");
      }
      closeModal();
      if (state._viewPaper) await openPaperView(state._viewPaper.id);
      if (paperId && state._currentPaper && state._currentPaper.id === paperId) await refreshPaper(paperId);
      else if (isEdit && state._currentPaper && state._currentPaper.id === note.paper_id) await refreshPaper(note.paper_id);
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
  const re = /\[\[img:(\d+)\]\]/g;
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
      else if (ch.nodeName === "DIV" || ch.nodeName === "P") { walk(ch); content += "\n"; }
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
function openModal(html) {
  $("#modal").innerHTML = html;
  $("#modal-backdrop").hidden = false;
}
function closeModal() {
  $("#modal-backdrop").hidden = true;
  $("#modal").innerHTML = "";
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
      await req("POST", "/api/projects", { name, note: $("#m-note").value.trim() });
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
      await req("POST", "/api/folders", { project_id: state.currentProjectId, parent_id: parentId || null, name });
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

/* 导入论文（弹窗：拖拽 PDF / 选文件） */
function openPaperModal(existing) {
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
    </div>`}
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
        await req("PUT", "/api/papers", { id: existing.id, ...payload });
        toast("已保存修改");
        closeModal();
        await openPaperDrawer(existing.id);
        await loadPapers();
      } else {
        const fid = targetFolderId();
        if (!fid) {
          // 根目录：需要一个临时文件夹？后端要求 folder_id。这里确保有根文件夹
          await ensureRootFolder();
          await req("POST", "/api/papers", { folder_id: state.currentFolderId, ...payload });
        } else {
          await req("POST", "/api/papers", { folder_id: fid, ...payload });
        }
        toast("论文已保存");
        closeModal();
        await loadTree();
        await loadPapers();
        await loadProjects();
      }
    } catch (e) { toast(e.message, true); }
  };

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
    // 自动定位本地路径：按文件名在论文目录搜索同名 PDF
    try {
      const fl = await req("POST", "/api/find_local", { filename: file.name });
      if (fl.paths && fl.paths.length) {
        $("#m-path").value = fl.paths[0];
        sub.textContent = fl.paths.length > 1
          ? `已自动提取，并定位到本地文件（共找到 ${fl.paths.length} 个同名，已取第一个，可改）`
          : "已自动提取，并已定位到本地文件路径";
      } else {
        sub.textContent = "已自动提取，但未在论文目录找到同名文件，本地路径需手动填写";
      }
    } catch (e2) {
      sub.textContent = "已自动提取，请核对后保存";
    }
    // 文件名作为标题兜底
    if (!meta.title_en && file.name.toLowerCase().endsWith(".pdf")) {
      $("#m-title_en").value = file.name.replace(/\.pdf$/i, "");
    }
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

/* ============ 初始化 ============ */
function bindGlobal() {
  $("#auth-submit").addEventListener("click", doAuth);
  $("#auth-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth(); });
  $("#auth-username").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#auth-password").focus(); });
  $("#new-project-btn").addEventListener("click", openProjectModal);
  $("#add-folder-btn").addEventListener("click", () => openFolderModal(state.currentFolderId));
  $("#add-paper-btn").addEventListener("click", () => openPaperModal(null));
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
  $("#recycle-restore-btn").addEventListener("click", restoreSelectedRecycle);
  $("#recycle-purge-btn").addEventListener("click", purgeSelectedRecycle);
  $("#recycle-clear-sel").addEventListener("click", clearSelection);
  // Esc 清空选择
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") clearSelection(); });
}

function init() {
  bindGlobal();
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
