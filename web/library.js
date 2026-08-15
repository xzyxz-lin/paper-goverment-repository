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
  searchTerm: "",
  folderOpen: {},          // folderId -> bool 展开状态
  // 多选删除（仿照论文观察台）
  selPapers: new Set(),    // 当前项目里的论文 id
  selProjects: new Set(),  // 项目卡片 id
  selFolders: new Set(),   // 文件夹 id
  selectionAnchor: { paper: null, project: null, folder: null }, // Shift 范围选择的起点
  deletedCount: { projects: 0, folders: 0, papers: 0 },
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
    <button class="nav-item is-active" data-view="projects" type="button">
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
  }
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
  if (total > 0) {
    bar.hidden = false;
    $("#bulk-delete-count").textContent = `已选中 ${total} 项`;
  } else {
    bar.hidden = true;
  }
}

function clearSelection() {
  state.selPapers.clear();
  state.selProjects.clear();
  state.selFolders.clear();
  state.selectionAnchor = { paper: null, project: null, folder: null };
  updateSelectionUI();
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

// 通用点击处理：单击行为取决于是否按住 Ctrl/Shift
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
    renderNav();
    if (state.currentProjectId) {
      await loadTree();
      await loadPapers();
    } else {
      renderProjects();
    }
    updateSelectionUI();
  } catch (e) {
    toast("删除失败：" + e.message, true);
  }
}

async function restoreAllDeleted() {
  if (!confirm("恢复全部已删除的项目/文件夹/论文？")) return;
  try {
    const r = await req("POST", "/api/deleted/clear", {});
    toast(r.message || "已恢复全部删除项");
    await loadProjects();
    renderNav();
    if (state.currentProjectId) {
      // 恢复后当前项目可能不再存在，校验
      if (!state.projects.find(p => p.id === state.currentProjectId)) {
        state.currentProjectId = null;
        showView("projects");
      } else {
        await loadTree();
        await loadPapers();
      }
    } else {
      renderProjects();
    }
  } catch (e) {
    toast("恢复失败：" + e.message, true);
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

  const openBtns = p.local_path ? `
    <div class="open-actions">
      <a class="article-open" id="open-pdf-btn" href="#"><svg><use href="#i-doc"/></svg><span>打开 PDF</span></a>
      <a class="article-open article-open--ghost" id="reveal-file-btn" href="#"><svg><use href="#i-folder-open"/></svg><span>打开所在文件夹</span></a>
    </div>` : `
    <p style="color:var(--ink-700);font-size:.76rem;margin:6px 0 0;">未设置本地路径。可在「编辑」中填写本地 PDF 的完整路径。</p>`;

  $("#drawer-body").innerHTML = `
    <div class="drawer-stats">
      <div class="drawer-stat"><span>思考标注</span><strong>${notes.length}</strong></div>
      <div class="drawer-stat"><span>截图</span><strong>${imgCount}</strong></div>
      <div class="drawer-stat"><span>日期</span><strong style="font-size:.85rem;">${esc(p.publish_date || "—")}</strong></div>
    </div>

    <table class="meta-table">${metaRows}</table>
    ${openBtns}

    <div class="drawer-section-title">
      <span>我的思考</span>
      <button class="scan-button scan-button--sm" id="edit-paper-btn" type="button" style="min-height:30px;padding:0 12px;font-size:.74rem;"><svg style="width:13px;height:13px;"><use href="#i-edit"/></svg>编辑论文</button>
    </div>

    <div id="notes-list">
      ${notes.map(n => renderNoteCard(n)).join("")}
    </div>

    <div class="drawer-section-title"><span>新增思考</span></div>
    <div class="note-compose">
      <div class="note-editor" id="note-editor" contenteditable="true" data-placeholder="这篇文章带给我什么启发？可写文字、可 Ctrl+V 贴图（插在光标处）、图文穿插、换行缩进，写完点「保存思考」才算一条。"></div>
      <div class="note-compose__bar">
        <span class="note-compose__hint">支持：文字 + 多张截图 + 图间插话 + 换行缩进</span>
        <button class="scan-button scan-button--ghost" id="compose-add-img" type="button" style="min-height:38px;padding:0 12px;"><svg style="width:15px;height:15px;"><use href="#i-image"/></svg><span>插图</span></button>
        <button class="scan-button" id="add-note-btn" type="button"><svg><use href="#i-plus"/></svg><span>保存思考</span></button>
      </div>
    </div>`;

  // 绑定
  $("#drawer-close").onclick = closeDrawer;
  $("#edit-paper-btn").onclick = () => { closeDrawer(); openPaperModal(p); };
  if (p.local_path) {
    $("#open-pdf-btn").onclick = (e) => { e.preventDefault(); openLocal(p.local_path, false); };
    $("#reveal-file-btn").onclick = (e) => { e.preventDefault(); openLocal(p.local_path, true); };
  }

  // 思考编辑区：图文混排（暂存图片，点保存才提交）
  state.composeImages = [];
  const editor = $("#note-editor");
  editor.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        e.preventDefault();
        const blob = it.getAsFile();
        insertComposeImage(blob, editor);
        return;
      }
    }
  });
  $("#compose-add-img").onclick = () => pickComposeImage(editor);
  $("#add-note-btn").onclick = () => addNote(p.id, editor);

  // 已有笔记的删除
  $$("#notes-list .note-card__del").forEach(btn => btn.addEventListener("click", () => deleteNote(parseInt(btn.dataset.note), p.id)));
}

function renderNoteCard(n) {
  return `
    <div class="note-card">
      <div class="note-card__head">
        <span class="note-card__time">${esc((n.created_at || "").replace("T", " ").slice(0, 16))}</span>
        <button class="note-card__del" data-note="${n.id}" type="button"><svg style="width:12px;height:12px;"><use href="#i-trash"/></svg>删除</button>
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
    if (txt && txt.trim()) html += `<p class="note-text">${esc(txt)}</p>`;
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

// 点「插图」按钮选择图片加入编辑区
function pickComposeImage(editor) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const f = input.files[0];
    if (!f) return;
    fileToBase64(f).then(b64 => {
      const ext = (f.name.split(".").pop() || "png").toLowerCase();
      const idx = state.composeImages.length;
      state.composeImages.push({ data: b64, ext });
      const img = document.createElement("img");
      img.src = "data:image/" + ext + ";base64," + b64;
      img.dataset.idx = idx;
      img.className = "compose-img";
      editor.appendChild(img);
      editor.focus();
    });
  };
  input.click();
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
  if (!confirm("删除这条思考？")) return;
  await req("DELETE", "/api/notes?id=" + nid);
  toast("已删除");
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
  $("#drawer-backdrop").classList.remove("is-open");
  $("#detail-drawer").classList.remove("is-open");
  $("#detail-drawer").setAttribute("aria-hidden", "true");
  setTimeout(() => { $("#drawer-backdrop").hidden = true; }, 320);
}
$("#drawer-backdrop").addEventListener("click", closeDrawer);

/* ============ 弹窗 ============ */
function openModal(html) {
  $("#modal").innerHTML = html;
  $("#modal-backdrop").hidden = false;
}
function closeModal() {
  $("#modal-backdrop").hidden = true;
  $("#modal").innerHTML = "";
}
$("#modal-backdrop").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });

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
  if (!confirm(`删除文件夹「${node?.name || ""}」${extra}？其中的论文也会一并删除。\n（可点侧边栏「回收站 / 恢复全部」撤销）`)) return;
  const r = await req("DELETE", "/api/folders?id=" + fid);
  toast(r.message || "已删除");
  state.selFolders.delete(fid);
  if (state.currentFolderId === fid) { state.currentFolderId = null; state.currentFolderPath = []; }
  await loadTree();
  await loadPapers();
  await loadProjects();
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
        await refreshPaper(existing.id);
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
  $("#bulk-clear-sel").addEventListener("click", clearSelection);
  // 回收站：恢复全部
  const recycleBtn = $("#recycle-btn");
  if (recycleBtn) recycleBtn.addEventListener("click", restoreAllDeleted);
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
