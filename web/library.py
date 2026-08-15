#!/usr/bin/env python3
"""
私人文献库 - 本地 Web 后端（标准库 + sqlite3 + pdfplumber）。

仿照「论文观察台」的架构：BaseHTTPRequestHandler + ThreadingHTTPServer。

核心设计：
  - 账号 → 项目（课题）→ 无限嵌套文件夹 → 论文（只存元信息 + 本地 PDF 路径）→ 思考标注 → 截图
  - PDF 文件本身不长期存储，只在导入时解析提取元信息（标题/作者/期刊/日期/DOI）
  - 粘贴的截图存到项目根目录 picture asset/ 下，按 项目/论文 分层，便于人工查找

数据存储：data/library.db（SQLite）
图片资产：picture asset/ 目录
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import subprocess
import threading
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

# ===== 路径 =====
APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "library.db"
ASSET_DIR = PROJECT_DIR / "picture asset"
DELETED_PATH = PROJECT_DIR / "data" / "deleted.json"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
ASSET_DIR.mkdir(parents=True, exist_ok=True)


# ===== 删除索引（仿照论文观察台：标记删除，非物理删除，可恢复）=====
_DELETED_LOCK = threading.Lock()


def _deleted_empty() -> dict:
    return {"projects": [], "folders": [], "papers": []}


def load_deleted() -> dict:
    """读取 data/deleted.json。文件不存在/损坏则返回空索引。"""
    if not DELETED_PATH.exists():
        return _deleted_empty()
    try:
        with DELETED_PATH.open("r", encoding="utf-8") as f:
            d = json.load(f)
        for k in ("projects", "folders", "papers"):
            d.setdefault(k, [])
        return d
    except Exception:
        return _deleted_empty()


def save_deleted(d: dict) -> None:
    """写回 data/deleted.json（原子写：先写临时文件再替换）。"""
    with _DELETED_LOCK:
        try:
            tmp = DELETED_PATH.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(DELETED_PATH)
        except Exception:
            pass


def _deleted_filter_clause(kind: str, alias: str = "t") -> tuple[str, list]:
    """生成 SQL WHERE 子句片段 + 参数：过滤掉 id 在删除索引里的行。
    kind: 'projects' | 'folders' | 'papers'
    """
    d = load_deleted()
    ids = d.get(kind, [])
    if not ids:
        return "", []
    placeholders = ",".join("?" for _ in ids)
    return f" AND {alias}.id NOT IN ({placeholders})", list(ids)


def _deleted_folder_subtree_ids(root_id: int, all_folders: list[dict]) -> set[int]:
    """返回 root_id 及其所有后代文件夹的 id 集合。"""
    children: dict[int, list[int]] = {}
    for f in all_folders:
        children.setdefault(f["parent_id"], []).append(f["id"])
    out: set[int] = set()
    stack = [root_id]
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


def _descendant_folder_ids(all_folders: list[dict], root_ids: list[int]) -> set[int]:
    """root_ids 中每个 id 加上所有后代 id。"""
    children: dict[int, list[int]] = {}
    for f in all_folders:
        children.setdefault(f["parent_id"], []).append(f["id"])
    out: set[int] = set()
    stack = list(root_ids)
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


def _soft_delete_one(kind: str, item_id: int) -> int:
    """单条软删除：加入索引。返回实际新增数（0 或 1）。"""
    return _soft_delete_one_batch(kind, [item_id])


def _soft_delete_one_batch(kind: str, ids: list[int]) -> int:
    """批量软删除：把 ids 加入 deleted[kind]。返回新增数。"""
    if not ids:
        return 0
    d = load_deleted()
    existing = set(d.get(kind, []))
    added = 0
    for i in ids:
        if i not in existing:
            existing.add(i)
            added += 1
    d[kind] = sorted(existing)
    save_deleted(d)
    return added


def _soft_delete_folders(fids: list[int]) -> int:
    """批量软删除文件夹：把所有后代文件夹 + 它们内部的论文一起加入索引。"""
    if not fids:
        return 0
    conn = get_db()
    all_rows = conn.execute("SELECT id, parent_id FROM folder").fetchall()
    all_folders = [dict(r) for r in all_rows]
    # 全部要删的文件夹 id（含后代）
    target_folders = _descendant_folder_ids(all_folders, fids)
    # 这些文件夹里所有论文
    if target_folders:
        ph = ",".join("?" for _ in target_folders)
        paper_rows = conn.execute(
            f"SELECT id FROM paper WHERE folder_id IN ({ph})", list(target_folders)
        ).fetchall()
        target_papers = [r["id"] for r in paper_rows]
    else:
        target_papers = []

    d = load_deleted()
    f_existing = set(d.get("folders", []))
    p_existing = set(d.get("papers", []))
    added_f = sum(1 for x in target_folders if not (x in f_existing or f_existing.add(x)))
    added_p = sum(1 for x in target_papers if not (x in p_existing or p_existing.add(x)))
    d["folders"] = sorted(f_existing)
    d["papers"] = sorted(p_existing)
    save_deleted(d)
    return len(target_folders)

# ===== 数据库连接（每线程独立） =====
_local = threading.local()


def get_db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        _local.conn = conn
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS user (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS folder (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            parent_id INTEGER REFERENCES folder(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS paper (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
            title_en TEXT DEFAULT '',
            title_zh TEXT DEFAULT '',
            journal TEXT DEFAULT '',
            authors TEXT DEFAULT '',
            publish_date TEXT DEFAULT '',
            doi TEXT DEFAULT '',
            url TEXT DEFAULT '',
            local_path TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS note (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id INTEGER NOT NULL REFERENCES paper(id) ON DELETE CASCADE,
            content TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS image (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            rel_path TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()


# ===== 通用工具 =====
def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000).hex()
    return digest, salt


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


# ===== 会话 token（内存，重启需重新登录） =====
SESSIONS: dict[str, int] = {}  # token -> user_id
SESSIONS_LOCK = threading.Lock()


def create_session(user_id: int) -> str:
    token = secrets.token_hex(24)
    with SESSIONS_LOCK:
        SESSIONS[token] = user_id
    return token


def session_user(token: str | None) -> int | None:
    if not token:
        return None
    with SESSIONS_LOCK:
        return SESSIONS.get(token)


def require_user(handler: BaseHTTPRequestHandler) -> int | None:
    """从 Authorization 头解析 token，返回 user_id 或 None。"""
    auth = handler.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return session_user(auth[7:].strip())
    return None


# ===== 文件夹树 =====
def build_folder_tree(project_id: int) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM folder WHERE project_id = ? ORDER BY sort_order, id", (project_id,)
    ).fetchall()
    all_folders = [dict(r) for r in rows]
    # 过滤掉已软删除的文件夹（及其后代）
    deleted = load_deleted()
    deleted_folder_ids = set(deleted.get("folders", []))
    valid_folder_ids = {f["id"] for f in all_folders} - deleted_folder_ids
    # 还要剪枝：若某文件夹的祖先被删了，它虽不在索引里，也应隐藏
    keep: set[int] = set()
    for f in all_folders:
        if f["id"] not in valid_folder_ids:
            continue
        # 追溯祖先链，任意祖先在 deleted_folder_ids 就剔除
        cur = f["parent_id"]
        bad = False
        while cur is not None:
            if cur in deleted_folder_ids:
                bad = True
                break
            cur = next((x["parent_id"] for x in all_folders if x["id"] == cur), None)
        if not bad:
            keep.add(f["id"])
    folders = [f for f in all_folders if f["id"] in keep]
    by_parent: dict[int | None, list[dict]] = {}
    for f in folders:
        by_parent.setdefault(f["parent_id"], []).append(f)
    # 统计每个文件夹直接论文数（同时过滤已删除的论文）
    deleted_paper_ids = set(deleted.get("papers", []))
    paper_counts: dict[int, int] = {}
    for r in conn.execute(
        "SELECT folder_id, COUNT(*) AS c FROM paper WHERE folder_id IN "
        "(SELECT id FROM folder WHERE project_id = ?) AND id NOT IN ({}) "
        "GROUP BY folder_id".format(
            ",".join("?" for _ in deleted_paper_ids) if deleted_paper_ids else "0"
        ),
        ([project_id] if not deleted_paper_ids else [project_id, *deleted_paper_ids]),
    ).fetchall():
        paper_counts[r["folder_id"]] = r["c"]

    def build(parent_id):
        result = []
        for f in by_parent.get(parent_id, []):
            node = dict(f)
            node["paper_count"] = paper_counts.get(f["id"], 0)
            node["children"] = build(f["id"])
            result.append(node)
        return result

    return build(None)


# ===== 安全文件名 =====
def safe_name(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", name).strip().strip(".")
    return name[:120] or "untitled"


# ===== DOI 前缀 → 期刊名映射（比解析页眉可靠得多）=====
# 覆盖用户常读期刊 + 常见出版商。key 为 DOI 中 / 之后的小写片段。
DOI_JOURNAL_MAP = {
    # Elsevier
    "j.watres": "Water Research",
    "j.memsci": "Journal of Membrane Science",
    "j.desal": "Desalination",
    "j.seppur": "Separation and Purification Technology",
    "j.jwpe": "Journal of Water Process Engineering",
    "j.scitotenv": "Science of the Total Environment",
    "j.jhazmat": "Journal of Hazardous Materials",
    "j.watpro": "Water Process Engineering",
    "j.colsurfa": "Colloids and Surfaces A",
    "j.cej": "Chemical Engineering Journal",
    # ACS（10.1021/acs.xxx）
    "acs.est": "Environmental Science & Technology",
    "acs.estwater": "ACS ES&T Water",
    "acs.estlett": "Environmental Science & Technology Letters",
    "acsami": "ACS Applied Materials & Interfaces",
    "acs.langmuir": "Langmuir",
    # Nature / Springer（10.1038/sxxxxx）
    "s41586": "Nature",
    "s41467": "Nature Communications",
    "s44221": "Nature Water",
    "s41545": "npj Clean Water",
    "s41587": "Nature Biotechnology",
    "s41561": "Nature Geoscience",
    # MDPI
    "membranes": "Membranes",
    # RSC
    "d0ew": "Environmental Science: Water Research & Technology",
}

# 所有已知期刊名（用于从标题开头剔除误抓的期刊名）
KNOWN_JOURNALS = sorted(set(DOI_JOURNAL_MAP.values()), key=len, reverse=True)


def _journal_from_doi(doi: str) -> str:
    """从 DOI 片段识别期刊名。"""
    if not doi:
        return ""
    d = doi.lower()
    for key, name in DOI_JOURNAL_MAP.items():
        if key in d:
            return name
    return ""


def _translate_title(title: str) -> str:
    """翻译英文标题为中文（复用 translator.py），失败返回空。"""
    if not title:
        return ""
    try:
        from translator import translate_title, _save_cache
        zh = translate_title(title)
        try:
            _save_cache()
        except Exception:
            pass
        if zh and zh != title:
            return zh
    except Exception:
        pass
    return ""


# ===== PDF 元信息提取 =====
def extract_pdf_meta(pdf_bytes: bytes) -> dict:
    """解析 PDF 首页，尽力提取 title/doi/authors/journal/publish_date。

    返回 dict，字段可能为空字符串。
    """
    import pdfplumber

    result = {
        "title_en": "",
        "title_zh": "",
        "journal": "",
        "authors": "",
        "publish_date": "",
        "doi": "",
    }
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            if not pdf.pages:
                return result
            # 全文文本（前 3 页）用于 DOI / 日期 / 期刊
            full_text_parts = []
            for page in pdf.pages[:3]:
                try:
                    full_text_parts.append(page.extract_text() or "")
                except Exception:
                    pass
            full_text = "\n".join(full_text_parts)
            first_text = full_text_parts[0] if full_text_parts else ""

            # 1) DOI（全文找）
            doi_m = re.search(r"\b10\.\d{4,9}/[^\s\"']+", full_text)
            if doi_m:
                result["doi"] = doi_m.group(0).rstrip(".,;):")

            # 2) 标题：首页字号最大的行；剔除「整行就是期刊名」的页眉行
            words = pdf.pages[0].extract_words(
                extra_attrs=["size"], use_text_flow=False, keep_blank_chars=False
            ) if pdf.pages else []
            # 过滤 PDF 装饰字符（如 +、·、|、—、* 等纯标点「词」）——
            # 这些是边框/列表项标记，不应进标题/作者。
            _ALNUM = re.compile(r'[A-Za-z0-9\u4e00-\u9fff]')
            words = [w for w in words if _ALNUM.search(w["text"])]
            # 按 top 坐标聚合成行
            lines: dict[float, dict] = {}
            for w in words:
                top = round(w["top"] / 3) * 3
                size = float(w.get("size") or 0)
                entry = lines.setdefault(top, {"text": "", "size": 0})
                entry["text"] += (" " if entry["text"] else "") + w["text"]
                entry["size"] = max(entry["size"], size)
            sorted_lines = sorted(lines.values(), key=lambda x: -x["size"])
            if sorted_lines:
                max_size = sorted_lines[0]["size"]
                # 取字号接近最大、按 top 从上到下排序的行
                title_rows = [(t, l) for t, l in lines.items() if l["size"] >= max_size - 1.5]
                title_rows.sort(key=lambda x: x[0])
                # 过滤掉「整行就是期刊名」的页眉行（页眉期刊名字号可能和标题一样大）
                title_texts = []
                for t, l in title_rows:
                    txt = l["text"].strip()
                    if not txt:
                        continue
                    if any(txt.lower() == jn.lower() for jn in KNOWN_JOURNALS):
                        continue
                    title_texts.append(txt)
                title = " ".join(title_texts)
                title = re.sub(r"\s+", " ", title).strip()
                # 去掉首尾残留的孤立装饰标点（兜底）
                title = re.sub(r'^[\s+·•\-|—–*()【】<>·]+', '', title)
                title = re.sub(r'[\s+·•\-|—–*()【】<>·]+$', '', title).strip()
                # 剔除标题开头误抓的期刊名（页眉期刊名没单独成行时）
                for jname in KNOWN_JOURNALS:
                    if title.lower().startswith(jname.lower()):
                        title = title[len(jname):].strip(" .,:-·–—")
                        break
                result["title_en"] = title[:400]

            # 3) 日期：Received/Accepted/Published/Available online/© 年份
            date_m = re.search(
                r"(?:Received|Accepted|Published(?:\s+online)?|Available\s+online)[:\s]*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\.?\s+\d{4})",
                full_text, re.I,
            )
            if date_m:
                result["publish_date"] = date_m.group(1)
            else:
                date_m2 = re.search(r"©\s*(\d{4})", full_text)
                if date_m2:
                    result["publish_date"] = date_m2.group(1)

            # 4) 期刊名：优先 DOI 前缀映射（最可靠），其次页眉卷号行 / 版权行
            result["journal"] = _journal_from_doi(result["doi"])
            if not result["journal"]:
                journal_m = re.search(
                    r"([A-Z][A-Za-z &.\-]{5,60}?)\s*,?\s+(?:Vol\.?|vol\.?)\s*\d+", first_text
                )
                if journal_m:
                    result["journal"] = journal_m.group(1).strip()
            if not result["journal"]:
                # 版权行：© 2023 Elsevier ...
                journal_m2 = re.search(r"©\s*\d{4}\s+([A-Za-z][A-Za-z &.\-]{3,60})", full_text)
                if journal_m2:
                    result["journal"] = journal_m2.group(1).strip()

            # 5) 作者：标题下方、含逗号/and 的姓名行（启发式，拿不准留空）
            if sorted_lines:
                # 找标题行之后、字号中等偏上的行
                title_tops = {round(l_top) for l_top in lines if any(
                    l["text"].strip() in result["title_en"] for l in lines.values()
                )}
                # 简化：取前 12 行里含 ',' 或 ' and ' 的行
                top_lines = sorted(lines.items())[:12]
                author_cand = []
                for top, l in top_lines:
                    t = l["text"].strip()
                    if not t:
                        continue
                    if t == result["title_en"]:
                        continue
                    if ("," in t or re.search(r"\band\b", t, re.I)) and len(t) < 200 and l["size"] > 9:
                        author_cand.append(t)
                        break
                if author_cand:
                    result["authors"] = author_cand[0][:300]
    except Exception:
        # 解析失败返回空
        pass
    # 自动翻译中文标题（独立于解析，失败静默留空）
    if result.get("title_en") and not result.get("title_zh"):
        result["title_zh"] = _translate_title(result["title_en"])
    return result


# ===== 图片存储 =====
def store_image(project_id: int, paper_id: int, note_id: int, data_b64: str, ext: str) -> dict:
    """把 base64 图片存到 picture asset/<项目>/<论文>/ 下，返回 image 记录。"""
    ext = (ext or "png").lower().lstrip(".")
    if ext not in ("png", "jpg", "jpeg", "gif", "webp", "bmp"):
        ext = "png"
    try:
        raw = base64.b64decode(data_b64)
    except Exception:
        raise ValueError("图片数据无效")

    # 目录：picture asset/<project_name>/<paper_标题>
    conn = get_db()
    p = conn.execute("SELECT name FROM project WHERE id = ?", (project_id,)).fetchone()
    pa = conn.execute(
        "SELECT title_en FROM paper WHERE id = ?", (paper_id,)
    ).fetchone()
    project_name = safe_name(p["name"] if p else f"project{project_id}")
    paper_name = safe_name((pa["title_en"] if pa else "paper") or f"paper{paper_id}")[:80]
    subdir = ASSET_DIR / project_name / paper_name
    subdir.mkdir(parents=True, exist_ok=True)

    fname = f"{now_iso().replace(':', '').replace('-', '').replace('T', '_')}_{uuid.uuid4().hex[:6]}.{ext}"
    fpath = subdir / fname
    fpath.write_bytes(raw)

    rel_path = str(fpath.relative_to(PROJECT_DIR)).replace("\\", "/")
    cur = conn.execute(
        "INSERT INTO image (note_id, file_path, rel_path, created_at) VALUES (?,?,?,?)",
        (note_id, str(fpath), rel_path, now_iso()),
    )
    conn.commit()
    return {"id": cur.lastrowid, "file_path": str(fpath), "rel_path": rel_path}


# ===== 本地 PDF 路径自动定位 =====
SEARCH_DIRS_PATH = PROJECT_DIR / "data" / "search_dirs.json"
DEFAULT_SEARCH_DIRS = [
    r"A:\研零课题",
    os.path.join(os.environ.get("USERPROFILE", ""), "Downloads"),
    os.path.join(os.environ.get("USERPROFILE", ""), "Desktop"),
    os.path.join(os.environ.get("USERPROFILE", ""), "Documents"),
]


def _search_dirs() -> list[str]:
    """读取搜索目录配置（data/search_dirs.json），缺省用默认目录。"""
    if SEARCH_DIRS_PATH.exists():
        try:
            dirs = json.loads(SEARCH_DIRS_PATH.read_text(encoding="utf-8")).get("dirs", [])
            if dirs:
                return [d for d in dirs if d]
        except Exception:
            pass
    return DEFAULT_SEARCH_DIRS


def find_local_pdf(filename: str) -> list[str]:
    """按文件名在搜索目录里递归查找本地 PDF，返回完整路径列表（最多 20 个）。"""
    filename = (filename or "").strip()
    if not filename:
        return []
    target = filename.lower()
    base = re.sub(r"\.pdf$", "", filename, flags=re.I).lower()
    matches: list[str] = []
    for root_dir in _search_dirs():
        root_dir = (root_dir or "").strip()
        if not root_dir or not os.path.isdir(root_dir):
            continue
        for dirpath, dirs, files in os.walk(root_dir):
            # 限制深度，避免扫描过慢
            depth = dirpath[len(root_dir):].count(os.sep)
            if depth > 6:
                dirs[:] = []
                continue
            for fn in files:
                fl = fn.lower()
                if not fl.endswith(".pdf"):
                    continue
                if fl == target or re.sub(r"\.pdf$", "", fl) == base:
                    matches.append(os.path.join(dirpath, fn))
                    if len(matches) >= 20:
                        return matches
    return matches


# ===== 打开本地文件 =====
def open_local(path: str, reveal: bool = False) -> dict:
    """打开本地 PDF（默认程序）或资源管理器中定位。Windows 专用。"""
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.exists(path):
        return {"ok": False, "error": f"路径不存在：{path}"}
    try:
        if reveal:
            if os.name == "nt":
                subprocess.Popen(["explorer", "/select,", path])
            else:
                subprocess.Popen(["xdg-open", str(Path(path).parent)])
        else:
            if os.name == "nt":
                os.startfile(path)  # type: ignore[attr-defined]
            else:
                subprocess.Popen(["xdg-open", path])
        return {"ok": True, "path": path}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ===== HTTP 响应 =====
def json_response(handler, payload, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


def _read_json_body(handler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    try:
        return json.loads(handler.rfile.read(length).decode("utf-8") or "{}")
    except Exception:
        return {}


def static_response(handler, filename: str) -> None:
    path = APP_DIR / filename
    if not path.exists():
        handler.send_error(404, "Not Found")
        return
    content_type = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
    }.get(path.suffix, "application/octet-stream")
    body = path.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


def asset_response(handler, rel_path: str) -> None:
    """serving picture asset 下的图片。防目录穿越。"""
    safe = unquote(rel_path).replace("\\", "/").lstrip("/")
    target = (PROJECT_DIR / safe).resolve()
    if not str(target).startswith(str(ASSET_DIR.resolve())) or not target.is_file():
        handler.send_error(404, "Not Found")
        return
    ext_map = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    }
    ct = ext_map.get(target.suffix.lower(), "application/octet-stream")
    body = target.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", ct)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _error(self, status, message):
        json_response(self, {"error": message}, status)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            if path in ("/", "/index.html"):
                static_response(self, "library.html")
            elif path == "/library.css":
                static_response(self, "library.css")
            elif path == "/library.js":
                static_response(self, "library.js")
            elif path.startswith("/assets/"):
                asset_response(self, path[len("/assets/"):])
            elif path == "/api/health":
                json_response(self, {"ok": True, "db": str(DB_PATH)})
            elif path == "/api/me":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                u = get_db().execute("SELECT id, username, created_at FROM user WHERE id = ?", (uid,)).fetchone()
                json_response(self, {"user": row_to_dict(u)})
            elif path == "/api/projects":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                conn = get_db()
                deleted_proj_ids = load_deleted().get("projects", [])
                if deleted_proj_ids:
                    placeholders = ",".join("?" for _ in deleted_proj_ids)
                    rows = conn.execute(
                        "SELECT * FROM project WHERE user_id = ? AND id NOT IN ({}) ORDER BY id DESC".format(placeholders),
                        (uid, *deleted_proj_ids),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM project WHERE user_id = ? ORDER BY id DESC", (uid,)
                    ).fetchall()
                projects = []
                for r in rows:
                    d = dict(r)
                    d["folder_count"] = conn.execute(
                        "SELECT COUNT(*) c FROM folder WHERE project_id = ?", (r["id"],)
                    ).fetchone()["c"]
                    d["paper_count"] = conn.execute(
                        "SELECT COUNT(*) c FROM paper WHERE folder_id IN "
                        "(SELECT id FROM folder WHERE project_id = ?)", (r["id"],)
                    ).fetchone()["c"]
                    projects.append(d)
                json_response(self, {"projects": projects})
            elif path == "/api/projects/tree":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                pid = int((qs.get("id") or [None])[0])
                json_response(self, {"folders": build_folder_tree(pid)})
            elif path == "/api/papers":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                fid = (qs.get("folder_id") or [None])[0]
                q = (qs.get("q") or [None])[0]
                conn = get_db()
                deleted = load_deleted()
                deleted_paper_ids = list(deleted.get("papers", []))
                # 计算当前用户可见的所有「未软删的文件夹」id（用于过滤在已删除文件夹里的论文）
                # 注意：这里不区分项目，因 papers 接口本身受 folder_id / 搜索参数约束
                deleted_folder_ids = list(deleted.get("folders", []))
                # 拼装 WHERE
                conds = []
                params: list = []
                if fid:
                    conds.append("folder_id = ?")
                    params.append(int(fid))
                if q:
                    conds.append("(title_en LIKE ? OR title_zh LIKE ? OR authors LIKE ? OR journal LIKE ?)")
                    like = f"%{q}%"
                    params += [like, like, like, like]
                if deleted_paper_ids:
                    conds.append("id NOT IN ({})".format(",".join("?" for _ in deleted_paper_ids)))
                    params += deleted_paper_ids
                if deleted_folder_ids:
                    conds.append("folder_id NOT IN ({})".format(",".join("?" for _ in deleted_folder_ids)))
                    params += deleted_folder_ids
                sql = "SELECT * FROM paper"
                if conds:
                    sql += " WHERE " + " AND ".join(conds)
                sql += " ORDER BY id DESC"
                rows = conn.execute(sql, params).fetchall()
                papers = []
                for r in rows:
                    d = dict(r)
                    notes = conn.execute(
                        "SELECT * FROM note WHERE paper_id = ? ORDER BY id", (r["id"],)
                    ).fetchall()
                    d["notes"] = []
                    for n in notes:
                        nd = dict(n)
                        nd["images"] = [dict(i) for i in conn.execute(
                            "SELECT * FROM image WHERE note_id = ? ORDER BY id", (n["id"],)
                        ).fetchall()]
                        d["notes"].append(nd)
                    papers.append(d)
                json_response(self, {"papers": papers})
            elif path == "/api/paper":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                pid = int((qs.get("id") or [None])[0])
                conn = get_db()
                r = conn.execute("SELECT * FROM paper WHERE id = ?", (pid,)).fetchone()
                if not r:
                    self._error(404, "论文不存在")
                    return
                # 软删除检查
                deleted = load_deleted()
                if pid in deleted.get("papers", []):
                    self._error(404, "论文已被删除")
                    return
                if r["folder_id"] in deleted.get("folders", []):
                    self._error(404, "论文所在文件夹已被删除")
                    return
                d = dict(r)
                d["notes"] = []
                for n in conn.execute("SELECT * FROM note WHERE paper_id = ? ORDER BY id", (pid,)).fetchall():
                    nd = dict(n)
                    nd["images"] = [dict(i) for i in conn.execute(
                        "SELECT * FROM image WHERE note_id = ? ORDER BY id", (n["id"],)
                    ).fetchall()]
                    d["notes"].append(nd)
                json_response(self, {"paper": d})
            else:
                self._error(404, "Not Found")
        except Exception as e:
            self._error(500, str(e))

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/register":
                body = _read_json_body(self)
                username = (body.get("username") or "").strip()
                password = body.get("password") or ""
                if not username or len(username) > 40:
                    self._error(400, "用户名不能为空且不超过 40 字符")
                    return
                if len(password) < 4:
                    self._error(400, "密码至少 4 位")
                    return
                conn = get_db()
                exists = conn.execute("SELECT id FROM user WHERE username = ?", (username,)).fetchone()
                if exists:
                    self._error(409, "该用户名已存在")
                    return
                digest, salt = hash_password(password)
                cur = conn.execute(
                    "INSERT INTO user (username, password_hash, salt, created_at) VALUES (?,?,?,?)",
                    (username, digest, salt, now_iso()),
                )
                conn.commit()
                token = create_session(cur.lastrowid)
                json_response(self, {"ok": True, "token": token, "user": {"id": cur.lastrowid, "username": username}})
            elif path == "/api/login":
                body = _read_json_body(self)
                username = (body.get("username") or "").strip()
                password = body.get("password") or ""
                conn = get_db()
                u = conn.execute("SELECT * FROM user WHERE username = ?", (username,)).fetchone()
                if not u:
                    self._error(401, "用户名或密码错误")
                    return
                digest, _ = hash_password(password, u["salt"])
                if digest != u["password_hash"]:
                    self._error(401, "用户名或密码错误")
                    return
                token = create_session(u["id"])
                json_response(self, {"ok": True, "token": token, "user": {"id": u["id"], "username": u["username"]}})
            elif path == "/api/logout":
                auth = self.headers.get("Authorization", "")
                if auth.startswith("Bearer "):
                    with SESSIONS_LOCK:
                        SESSIONS.pop(auth[7:].strip(), None)
                json_response(self, {"ok": True})
            # ===== 批量软删除 + 恢复（仿照论文观察台 data/deleted.json）=====
            elif path == "/api/projects/delete":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                ids = [int(x) for x in (_read_json_body(self).get("ids") or []) if x]
                added = _soft_delete_one_batch("projects", ids)
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 个项目"})
            elif path == "/api/folders/delete":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                ids = [int(x) for x in (_read_json_body(self).get("ids") or []) if x]
                added = _soft_delete_folders(ids)
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 个文件夹"})
            elif path == "/api/papers/delete":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                ids = [int(x) for x in (_read_json_body(self).get("ids") or []) if x]
                added = _soft_delete_one_batch("papers", ids)
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 篇论文"})
            elif path == "/api/deleted/clear":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                # 清空所有删除索引 = 全部恢复
                save_deleted(_deleted_empty())
                json_response(self, {"ok": True, "message": "已恢复全部删除项"})
            elif path == "/api/projects":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                name = (body.get("name") or "").strip()
                if not name:
                    self._error(400, "项目名不能为空")
                    return
                conn = get_db()
                cur = conn.execute(
                    "INSERT INTO project (user_id, name, note, created_at) VALUES (?,?,?,?)",
                    (uid, name, body.get("note", "").strip(), now_iso()),
                )
                conn.commit()
                json_response(self, {"ok": True, "id": cur.lastrowid})
            elif path == "/api/folders":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                project_id = int(body.get("project_id"))
                parent_id = body.get("parent_id")
                parent_id = int(parent_id) if parent_id else None
                name = (body.get("name") or "").strip()
                if not name:
                    self._error(400, "文件夹名不能为空")
                    return
                conn = get_db()
                cur = conn.execute(
                    "INSERT INTO folder (project_id, parent_id, name, sort_order, created_at) VALUES (?,?,?,0,?)",
                    (project_id, parent_id, name, now_iso()),
                )
                conn.commit()
                json_response(self, {"ok": True, "id": cur.lastrowid})
            elif path == "/api/papers":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                folder_id = int(body.get("folder_id"))
                conn = get_db()
                cur = conn.execute(
                    """INSERT INTO paper
                       (folder_id, title_en, title_zh, journal, authors, publish_date, doi, url, local_path, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        folder_id,
                        body.get("title_en", "").strip(),
                        body.get("title_zh", "").strip(),
                        body.get("journal", "").strip(),
                        body.get("authors", "").strip(),
                        body.get("publish_date", "").strip(),
                        body.get("doi", "").strip(),
                        body.get("url", "").strip(),
                        body.get("local_path", "").strip(),
                        now_iso(),
                    ),
                )
                conn.commit()
                json_response(self, {"ok": True, "id": cur.lastrowid})
            elif path == "/api/pdf/extract":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                data_b64 = body.get("data") or ""
                if not data_b64:
                    self._error(400, "缺少 PDF 数据")
                    return
                # 兼容 data URL
                if "," in data_b64 and data_b64.startswith("data:"):
                    data_b64 = data_b64.split(",", 1)[1]
                try:
                    pdf_bytes = base64.b64decode(data_b64)
                except Exception:
                    self._error(400, "PDF 数据解码失败")
                    return
                meta = extract_pdf_meta(pdf_bytes)
                json_response(self, {"ok": True, "meta": meta})
            elif path == "/api/find_local":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                filename = (body.get("filename") or "").strip()
                paths = find_local_pdf(filename)
                json_response(self, {"ok": True, "paths": paths})
            elif path == "/api/notes":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                paper_id = int(body.get("paper_id"))
                content = body.get("content", "")
                conn = get_db()
                cur = conn.execute(
                    "INSERT INTO note (paper_id, content, created_at) VALUES (?,?,?)",
                    (paper_id, content, now_iso()),
                )
                conn.commit()
                json_response(self, {"ok": True, "id": cur.lastrowid})
            elif path == "/api/notes/images":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                note_id = int(body.get("note_id"))
                conn = get_db()
                n = conn.execute("SELECT paper_id FROM note WHERE id = ?", (note_id,)).fetchone()
                if not n:
                    self._error(404, "标注不存在")
                    return
                pa = conn.execute("SELECT folder_id FROM paper WHERE id = ?", (n["paper_id"],)).fetchone()
                folder = conn.execute("SELECT project_id FROM folder WHERE id = ?", (pa["folder_id"],)).fetchone()
                img = store_image(folder["project_id"], n["paper_id"], note_id, body.get("data") or "", body.get("ext") or "png")
                json_response(self, {"ok": True, "image": img})
            elif path == "/api/open":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                result = open_local(body.get("path") or "", reveal=bool(body.get("reveal")))
                json_response(self, result)
            else:
                self._error(404, "Not Found")
        except Exception as e:
            self._error(500, str(e))

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/papers":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                pid = int(body.get("id"))
                conn = get_db()
                cur = conn.execute(
                    """UPDATE paper SET title_en=?, title_zh=?, journal=?, authors=?,
                       publish_date=?, doi=?, url=?, local_path=? WHERE id=?""",
                    (
                        body.get("title_en", "").strip(),
                        body.get("title_zh", "").strip(),
                        body.get("journal", "").strip(),
                        body.get("authors", "").strip(),
                        body.get("publish_date", "").strip(),
                        body.get("doi", "").strip(),
                        body.get("url", "").strip(),
                        body.get("local_path", "").strip(),
                        pid,
                    ),
                )
                conn.commit()
                json_response(self, {"ok": True, "updated": cur.rowcount})
            elif path == "/api/notes":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                nid = int(body.get("id"))
                conn = get_db()
                cur = conn.execute(
                    "UPDATE note SET content=? WHERE id=?", (body.get("content", ""), nid)
                )
                conn.commit()
                json_response(self, {"ok": True, "updated": cur.rowcount})
            else:
                self._error(404, "Not Found")
        except Exception as e:
            self._error(500, str(e))

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            uid = require_user(self)
            if not uid:
                self._error(401, "未登录")
                return
            # 兼容旧 API：单条软删
            if path == "/api/projects":
                pid = int((qs.get("id") or [None])[0])
                _soft_delete_one("projects", pid)
                json_response(self, {"ok": True, "deleted": 1, "message": "已删除项目（可恢复）"})
                return
            if path == "/api/folders":
                fid = int((qs.get("id") or [None])[0])
                added = _soft_delete_folders([fid])
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 项（可恢复）"})
                return
            if path == "/api/papers":
                pid = int((qs.get("id") or [None])[0])
                _soft_delete_one("papers", pid)
                json_response(self, {"ok": True, "deleted": 1, "message": "已删除论文（可恢复）"})
                return
            if path == "/api/notes":
                nid = int((qs.get("id") or [None])[0])
                conn = get_db()
                conn.execute("DELETE FROM note WHERE id = ?", (nid,))
                conn.commit()
                json_response(self, {"ok": True})
                return
            if path == "/api/notes/images":
                iid = int((qs.get("id") or [None])[0])
                conn = get_db()
                img = conn.execute("SELECT * FROM image WHERE id = ?", (iid,)).fetchone()
                if img:
                    try:
                        Path(img["file_path"]).unlink(missing_ok=True)
                    except Exception:
                        pass
                    conn.execute("DELETE FROM image WHERE id = ?", (iid,))
                    conn.commit()
                json_response(self, {"ok": True})
                return
            self._error(404, "Not Found")
        except Exception as e:
            self._error(500, str(e))


def main():
    parser = argparse.ArgumentParser(description="私人文献库")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8040)
    args = parser.parse_args()

    init_db()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Private Library running at http://127.0.0.1:{args.port} (host={args.host})")
    print(f"DB: {DB_PATH}")
    print(f"Assets: {ASSET_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
