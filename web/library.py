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
import shutil
import sqlite3
import subprocess
import threading
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

# ===== 路径 =====
APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "library.db"
ASSET_DIR = PROJECT_DIR / "picture asset"
DELETED_PATH = PROJECT_DIR / "data" / "deleted.json"
RECYCLE_RETENTION_DAYS = 7
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
ASSET_DIR.mkdir(parents=True, exist_ok=True)


# ===== 删除索引（仿照论文观察台：标记删除，非物理删除，可恢复）=====
_DELETED_LOCK = threading.Lock()


def _deleted_empty() -> dict:
    return {"projects": [], "folders": [], "papers": [], "notes": []}


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
    kind: 'projects' | 'folders' | 'papers' | 'notes'
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


# ===== 结构化回收站（默认保留 7 天） =====
def _recycle_now() -> datetime:
    return datetime.now().astimezone()


def _recycle_related(record: sqlite3.Row | dict) -> dict[str, list[int]]:
    """读取回收记录关联的删除索引；兼容缺失字段的旧记录。"""
    raw = record["related_json"] if isinstance(record, sqlite3.Row) else record.get("related_json", "{}")
    try:
        data = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError):
        data = {}
    out = {"projects": [], "folders": [], "papers": [], "notes": []}
    for key in out:
        out[key] = [int(x) for x in data.get(key, []) if str(x).isdigit()]
    if not any(out.values()):
        kind = record["kind"] if isinstance(record, sqlite3.Row) else record.get("kind")
        entity_id = int(record["entity_id"] if isinstance(record, sqlite3.Row) else record.get("entity_id", 0))
        key = {"project": "projects", "folder": "folders", "paper": "papers", "note": "notes"}.get(kind)
        if key and entity_id:
            out[key] = [entity_id]
    return out


def _write_deleted_sets(data: dict, related: dict[str, list[int]], add: bool) -> None:
    """把一条回收记录对应的可见性索引写入/移出旧删除索引。"""
    for key in ("projects", "folders", "papers", "notes"):
        current = set(data.get(key, []))
        ids = set(related.get(key, []))
        if add:
            current.update(ids)
        else:
            current.difference_update(ids)
        data[key] = sorted(current)


def _folder_descendants(rows: list[dict], root_ids: list[int]) -> set[int]:
    return _descendant_folder_ids(rows, root_ids)


def _owned_folder_rows(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT f.id, f.project_id, f.parent_id, f.name
           FROM folder f JOIN project p ON p.id = f.project_id
           WHERE p.user_id = ?""",
        (user_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _recycle_insert(
    conn: sqlite3.Connection,
    user_id: int,
    kind: str,
    entity_id: int,
    project_id: int | None,
    folder_id: int | None,
    related: dict[str, list[int]],
) -> bool:
    now = _recycle_now()
    cur = conn.execute(
        """INSERT OR IGNORE INTO recycle_item
           (user_id, kind, entity_id, project_id, folder_id, related_json, deleted_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            user_id,
            kind,
            entity_id,
            project_id,
            folder_id,
            json.dumps(related, ensure_ascii=False),
            now.isoformat(timespec="seconds"),
            (now + timedelta(days=RECYCLE_RETENTION_DAYS)).isoformat(timespec="seconds"),
        ),
    )
    return cur.rowcount > 0


def move_to_recycle(user_id: int, kind: str, ids: list[int]) -> int:
    """验证归属后把项目、文件夹或论文移入回收站，返回新增的根项目数。"""
    ids = sorted({int(x) for x in ids if x})
    if not ids:
        return 0
    purge_expired_recycle_items()
    conn = get_db()
    deleted = load_deleted()
    added = 0

    if kind == "project":
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT id FROM project WHERE user_id = ? AND id IN ({placeholders})",
            [user_id, *ids],
        ).fetchall()
        for row in rows:
            project_id = row["id"]
            related = {"projects": [project_id], "folders": [], "papers": []}
            if _recycle_insert(conn, user_id, "project", project_id, project_id, None, related):
                _write_deleted_sets(deleted, related, True)
                added += 1

    elif kind == "folder":
        folder_rows = _owned_folder_rows(conn, user_id)
        by_id = {row["id"]: row for row in folder_rows}
        selected = [by_id[x] for x in ids if x in by_id]
        selected_ids = {row["id"] for row in selected}
        # 多选了父子文件夹时，只记录最外层文件夹，恢复/清除时语义更清楚。
        roots = []
        for row in selected:
            cur = row["parent_id"]
            nested = False
            while cur is not None:
                if cur in selected_ids:
                    nested = True
                    break
                cur = by_id.get(cur, {}).get("parent_id")
            if not nested:
                roots.append(row)
        for row in roots:
            folder_ids = sorted(_folder_descendants(folder_rows, [row["id"]]))
            if folder_ids:
                placeholders = ",".join("?" for _ in folder_ids)
                paper_rows = conn.execute(
                    f"SELECT id FROM paper WHERE folder_id IN ({placeholders})", folder_ids
                ).fetchall()
                paper_ids = [paper["id"] for paper in paper_rows]
            else:
                paper_ids = []
            related = {"projects": [], "folders": folder_ids, "papers": paper_ids}
            if _recycle_insert(conn, user_id, "folder", row["id"], row["project_id"], row["id"], related):
                _write_deleted_sets(deleted, related, True)
                added += 1

    elif kind == "paper":
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"""SELECT pa.id, pa.folder_id, f.project_id
                FROM paper pa
                JOIN folder f ON f.id = pa.folder_id
                JOIN project p ON p.id = f.project_id
                WHERE p.user_id = ? AND pa.id IN ({placeholders})""",
            [user_id, *ids],
        ).fetchall()
        for row in rows:
            paper_id = row["id"]
            related = {"projects": [], "folders": [], "papers": [paper_id]}
            if _recycle_insert(conn, user_id, "paper", paper_id, row["project_id"], row["folder_id"], related):
                _write_deleted_sets(deleted, related, True)
                added += 1

    elif kind == "note":
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"""SELECT n.id, n.paper_id, pa.folder_id, f.project_id
                FROM note n
                JOIN paper pa ON pa.id = n.paper_id
                JOIN folder f ON f.id = pa.folder_id
                JOIN project p ON p.id = f.project_id
                WHERE p.user_id = ? AND n.id IN ({placeholders})""",
            [user_id, *ids],
        ).fetchall()
        for row in rows:
            note_id = row["id"]
            related = {"projects": [], "folders": [], "papers": [], "notes": [note_id]}
            if _recycle_insert(conn, user_id, "note", note_id, row["project_id"], row["folder_id"], related):
                _write_deleted_sets(deleted, related, True)
                added += 1

    else:
        raise ValueError("不支持的回收类型")

    conn.commit()
    save_deleted(deleted)
    return added


def _folder_path(conn: sqlite3.Connection, folder_id: int | None) -> str:
    if not folder_id:
        return "根目录"
    row = conn.execute("SELECT project_id FROM folder WHERE id = ?", (folder_id,)).fetchone()
    if not row:
        return "根目录"
    rows = conn.execute("SELECT id, parent_id, name FROM folder WHERE project_id = ?", (row["project_id"],)).fetchall()
    by_id = {item["id"]: item for item in rows}
    names: list[str] = []
    cur = by_id.get(folder_id)
    while cur:
        names.append(cur["name"])
        cur = by_id.get(cur["parent_id"])
    return " / ".join(reversed(names)) or "根目录"


def _recycle_item_view(conn: sqlite3.Connection, record: sqlite3.Row) -> dict | None:
    kind = record["kind"]
    entity_id = record["entity_id"]
    if kind == "project":
        row = conn.execute("SELECT id, name FROM project WHERE id = ?", (entity_id,)).fetchone()
        if not row:
            return None
        folder_count = conn.execute("SELECT COUNT(*) c FROM folder WHERE project_id = ?", (entity_id,)).fetchone()["c"]
        paper_count = conn.execute(
            "SELECT COUNT(*) c FROM paper WHERE folder_id IN (SELECT id FROM folder WHERE project_id = ?)", (entity_id,)
        ).fetchone()["c"]
        title = row["name"]
        context = f"包含 {folder_count} 个文件夹、{paper_count} 篇论文"
        folder_path = ""
    elif kind == "folder":
        row = conn.execute(
            """SELECT f.id, f.name, f.project_id, p.name project_name
               FROM folder f JOIN project p ON p.id = f.project_id WHERE f.id = ?""",
            (entity_id,),
        ).fetchone()
        if not row:
            return None
        related = _recycle_related(record)
        title = row["name"]
        folder_path = _folder_path(conn, entity_id)
        context = f"包含 {max(0, len(related['folders']) - 1)} 个子文件夹、{len(related['papers'])} 篇论文"
    elif kind == "note":
        row = conn.execute(
            """SELECT n.id, n.content, n.created_at, pa.id paper_id, pa.title_en, pa.title_zh,
                      f.id folder_id, f.project_id, p.name project_name
               FROM note n
               JOIN paper pa ON pa.id = n.paper_id
               JOIN folder f ON f.id = pa.folder_id
               JOIN project p ON p.id = f.project_id WHERE n.id = ?""",
            (entity_id,),
        ).fetchone()
        if not row:
            return None
        title = "思考标注"
        folder_path = _folder_path(conn, row["folder_id"])
        context = row["title_en"] or row["title_zh"] or "（未命名论文）"

    else:
        row = conn.execute(
            """SELECT pa.id, pa.title_en, pa.title_zh, pa.journal, f.id folder_id, f.project_id, p.name project_name
               FROM paper pa
               JOIN folder f ON f.id = pa.folder_id
               JOIN project p ON p.id = f.project_id WHERE pa.id = ?""",
            (entity_id,),
        ).fetchone()
        if not row:
            return None
        title = row["title_en"] or row["title_zh"] or "（未命名论文）"
        folder_path = _folder_path(conn, row["folder_id"])
        context = row["journal"] or "论文记录"

    project_id = record["project_id"] or (row["project_id"] if "project_id" in row.keys() else row["id"])
    project_name = row["project_name"] if "project_name" in row.keys() else row["name"]
    expires_at = datetime.fromisoformat(record["expires_at"])
    remain_seconds = max(0, int((expires_at - _recycle_now()).total_seconds()))
    remaining_days = max(1, (remain_seconds + 86399) // 86400) if remain_seconds else 0
    item = {
        "id": record["id"],
        "kind": kind,
        "entity_id": entity_id,
        "project_id": project_id,
        "project_name": project_name,
        "folder_path": folder_path,
        "title": title,
        "context": context,
        "deleted_at": record["deleted_at"],
        "expires_at": record["expires_at"],
        "remaining_days": remaining_days,
    }
    if kind == "note":
        images = [dict(i) for i in conn.execute(
            "SELECT * FROM image WHERE note_id = ? ORDER BY id", (entity_id,)
        ).fetchall()]
        item["note_content"] = row["content"] or ""
        item["note_created_at"] = row["created_at"]
        item["note_images"] = images
    return item


def list_recycle_items(user_id: int) -> tuple[list[dict], dict]:
    purge_expired_recycle_items()
    conn = get_db()
    records = conn.execute(
        "SELECT * FROM recycle_item WHERE user_id = ? ORDER BY expires_at, id DESC", (user_id,)
    ).fetchall()
    items = [item for record in records if (item := _recycle_item_view(conn, record))]
    summary = {"total": len(items), "project": 0, "folder": 0, "paper": 0, "note": 0}
    for item in items:
        summary[item["kind"]] += 1
    return items, summary


def _image_paths_for_related(conn: sqlite3.Connection, related: dict[str, list[int]]) -> list[str]:
    paper_ids = related.get("papers", [])
    project_ids = related.get("projects", [])
    folder_ids = related.get("folders", [])
    if project_ids:
        placeholders = ",".join("?" for _ in project_ids)
        paper_rows = conn.execute(
            f"SELECT id FROM paper WHERE folder_id IN (SELECT id FROM folder WHERE project_id IN ({placeholders}))", project_ids
        ).fetchall()
        paper_ids = list({*paper_ids, *(row["id"] for row in paper_rows)})
    if folder_ids:
        placeholders = ",".join("?" for _ in folder_ids)
        paper_rows = conn.execute(f"SELECT id FROM paper WHERE folder_id IN ({placeholders})", folder_ids).fetchall()
        paper_ids = list({*paper_ids, *(row["id"] for row in paper_rows)})
    if not paper_ids:
        return []
    placeholders = ",".join("?" for _ in paper_ids)
    rows = conn.execute(
        f"SELECT i.file_path FROM image i JOIN note n ON n.id = i.note_id WHERE n.paper_id IN ({placeholders})", paper_ids
    ).fetchall()
    return [row["file_path"] for row in rows]


def _remove_asset_files(paths: list[str]) -> None:
    root = ASSET_DIR.resolve()
    for raw_path in paths:
        try:
            target = Path(raw_path).resolve()
            target.relative_to(root)
            target.unlink(missing_ok=True)
            parent = target.parent
            while parent != root:
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
        except (OSError, ValueError):
            continue


def _delete_recycle_records(records: list[sqlite3.Row]) -> int:
    """永久删除回收记录对应的数据和截图，仅由手动永久删除或 7 天到期调用。"""
    if not records:
        return 0
    conn = get_db()
    deleted_index = load_deleted()
    removed = 0
    for record in records:
        related = _recycle_related(record)
        asset_paths = _image_paths_for_related(conn, related)
        kind = record["kind"]
        entity_id = record["entity_id"]
        if kind == "project":
            cur = conn.execute("DELETE FROM project WHERE id = ? AND user_id = ?", (entity_id, record["user_id"]))
        elif kind == "folder":
            cur = conn.execute(
                """DELETE FROM folder WHERE id = ? AND project_id IN
                   (SELECT id FROM project WHERE user_id = ?)""",
                (entity_id, record["user_id"]),
            )
        elif kind == "note":
            # note 的 image 随 ON DELETE CASCADE 一起清理；截图文件在 note 查询时收集
            note_images = [dict(i) for i in conn.execute("SELECT * FROM image WHERE note_id = ?", (entity_id,)).fetchall()]
            for img in note_images:
                try:
                    Path(img["file_path"]).unlink(missing_ok=True)
                except Exception:
                    pass
            cur = conn.execute(
                """DELETE FROM note WHERE id = ? AND paper_id IN
                   (SELECT pa.id FROM paper pa JOIN folder f ON f.id = pa.folder_id
                    JOIN project p ON p.id = f.project_id WHERE p.user_id = ?)""",
                (entity_id, record["user_id"]),
            )
        else:
            cur = conn.execute(
                """DELETE FROM paper WHERE id = ? AND folder_id IN
                   (SELECT f.id FROM folder f JOIN project p ON p.id = f.project_id WHERE p.user_id = ?)""",
                (entity_id, record["user_id"]),
            )
        _write_deleted_sets(deleted_index, related, False)
        conn.execute("DELETE FROM recycle_item WHERE id = ?", (record["id"],))
        if cur.rowcount:
            _remove_asset_files(asset_paths)
            removed += 1
    conn.commit()
    save_deleted(deleted_index)
    return removed


def purge_expired_recycle_items() -> int:
    conn = get_db()
    now = _recycle_now().isoformat(timespec="seconds")
    records = conn.execute("SELECT * FROM recycle_item WHERE expires_at <= ?", (now,)).fetchall()
    return _delete_recycle_records(records)


def restore_recycle_items(user_id: int, recycle_ids: list[int] | None = None) -> int:
    conn = get_db()
    purge_expired_recycle_items()
    params: list = [user_id]
    sql = "SELECT * FROM recycle_item WHERE user_id = ?"
    if recycle_ids is not None:
        ids = sorted({int(x) for x in recycle_ids if x})
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        sql += f" AND id IN ({placeholders})"
        params += ids
    records = conn.execute(sql, params).fetchall()
    if not records:
        return 0
    deleted_index = load_deleted()
    for record in records:
        _write_deleted_sets(deleted_index, _recycle_related(record), False)
    ids = [record["id"] for record in records]
    placeholders = ",".join("?" for _ in ids)
    conn.execute(f"DELETE FROM recycle_item WHERE id IN ({placeholders})", ids)
    conn.commit()
    save_deleted(deleted_index)
    return len(records)


def purge_recycle_items(user_id: int, recycle_ids: list[int]) -> int:
    purge_expired_recycle_items()
    ids = sorted({int(x) for x in recycle_ids if x})
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    records = get_db().execute(
        f"SELECT * FROM recycle_item WHERE user_id = ? AND id IN ({placeholders})", [user_id, *ids]
    ).fetchall()
    return _delete_recycle_records(records)


def migrate_legacy_deleted_index() -> None:
    """把旧 deleted.json 中的已有删除项登记为新的 7 天回收记录，保留原索引作可见性控制。"""
    deleted = load_deleted()
    if deleted.get("_recycle_v2_migrated"):
        return
    conn = get_db()
    for kind, table, id_col, join_sql in (
        ("project", "project", "id", "SELECT id, user_id FROM project WHERE id IN ({})"),
        ("folder", "folder", "id", """SELECT f.id, p.user_id FROM folder f
            JOIN project p ON p.id = f.project_id WHERE f.id IN ({})"""),
        ("paper", "paper", "id", """SELECT pa.id, p.user_id FROM paper pa
            JOIN folder f ON f.id = pa.folder_id JOIN project p ON p.id = f.project_id WHERE pa.id IN ({})"""),
        ("note", "note", "id", """SELECT n.id, p.user_id FROM note n JOIN paper pa ON pa.id = n.paper_id
            JOIN folder f ON f.id = pa.folder_id JOIN project p ON p.id = f.project_id WHERE n.id IN ({})"""),
    ):
        key = kind + "s" if kind != "paper" else "papers"
        ids = [int(x) for x in deleted.get(key, []) if x]
        if not ids:
            continue
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(join_sql.format(placeholders), ids).fetchall()
        by_user: dict[int, list[int]] = {}
        for row in rows:
            by_user.setdefault(row["user_id"], []).append(row["id"])
        for user_id, owned_ids in by_user.items():
            move_to_recycle(user_id, kind, owned_ids)
    deleted = load_deleted()
    deleted["_recycle_v2_migrated"] = _recycle_now().isoformat(timespec="seconds")
    save_deleted(deleted)

# ===== 数据库连接（每线程独立） =====
_local = threading.local()

# 全局数据库写锁：ThreadingHTTPServer 多线程下，SQLite 写操作容易互相阻塞，
# 用一个锁串行化所有写请求，彻底避免 database is locked。
DB_LOCK = threading.Lock()


def get_db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        # WAL 模式 + 忙等待，缓解 ThreadingHTTPServer 多线程并发读写时的 database is locked
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        _local.conn = conn
    return conn


def init_db() -> None:
    conn = get_db()
    # 先给旧表补列，再执行 CREATE TABLE / CREATE INDEX，避免索引引用不存在的列
    _migrate_note_version_image_ids(conn)
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
        CREATE TABLE IF NOT EXISTS note_version (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            image_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_version_note ON note_version(note_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_note_version_expiry ON note_version(expires_at);
        CREATE TABLE IF NOT EXISTS session (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id, expires_at);
        CREATE TABLE IF NOT EXISTS recycle_item (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('project', 'folder', 'paper')),
            entity_id INTEGER NOT NULL,
            project_id INTEGER,
            folder_id INTEGER,
            related_json TEXT NOT NULL DEFAULT '{}',
            deleted_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            UNIQUE(kind, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_recycle_item_user_expiry
            ON recycle_item(user_id, expires_at);
        """
    )
    conn.commit()
    _migrate_recycle_item_kind(conn)
    _migrate_note_version_image_ids(conn)


def _migrate_note_version_image_ids(conn: sqlite3.Connection) -> None:
    """为已存在的老数据库 note_version 表补 image_ids_json / expires_at 列。"""
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='note_version'")
    if not cur.fetchone():
        return
    cols = {r[1] for r in conn.execute("PRAGMA table_info(note_version)")}
    if "image_ids_json" not in cols:
        conn.execute("ALTER TABLE note_version ADD COLUMN image_ids_json TEXT NOT NULL DEFAULT '[]'")
    if "expires_at" not in cols:
        default_expires = (datetime.utcnow() + timedelta(days=RECYCLE_RETENTION_DAYS)).isoformat()
        conn.execute(f"ALTER TABLE note_version ADD COLUMN expires_at TEXT NOT NULL DEFAULT '{default_expires}'")
    conn.commit()


def _migrate_recycle_item_kind(conn: sqlite3.Connection) -> None:
    """把 recycle_item.kind 的 CHECK 扩展为支持 'note'（SQLite 不能直接 ALTER CHECK）。"""
    cur = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='recycle_item'")
    sql = cur.fetchone()
    if not sql or "'note'" in (sql[0] or ""):
        return
    conn.executescript(
        """
        ALTER TABLE recycle_item RENAME TO recycle_item_old;
        CREATE TABLE recycle_item (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('project', 'folder', 'paper', 'note')),
            entity_id INTEGER NOT NULL,
            project_id INTEGER,
            folder_id INTEGER,
            related_json TEXT NOT NULL DEFAULT '{}',
            deleted_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            UNIQUE(kind, entity_id)
        );
        INSERT INTO recycle_item SELECT * FROM recycle_item_old;
        DROP TABLE recycle_item_old;
        CREATE INDEX IF NOT EXISTS idx_recycle_item_user_expiry
            ON recycle_item(user_id, expires_at);
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


# ===== 会话 token（持久化到 SQLite，重启不丢登录） =====
SESSION_DURATION_DAYS = 30


def create_session(user_id: int) -> str:
    token = secrets.token_hex(24)
    now = now_iso()
    expires = (datetime.utcnow() + timedelta(days=SESSION_DURATION_DAYS)).isoformat()
    conn = get_db()
    conn.execute(
        "INSERT INTO session (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
        (token, user_id, now, expires),
    )
    conn.commit()
    return token


def session_user(token: str | None) -> int | None:
    if not token:
        return None
    conn = get_db()
    row = conn.execute(
        "SELECT user_id FROM session WHERE token = ? AND expires_at > ?",
        (token, datetime.utcnow().isoformat()),
    ).fetchone()
    return row["user_id"] if row else None


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
    # Windows 会静默去掉目录名末尾的 '.' 和 ' '，切片之后必须再 strip 一次，
    # 否则 store_image() 里用 `safe_name(...)[:80]` 在空格处切开会得到尾部带空格的名字，
    # mkdir 成功但 write_bytes 找不到目录（FileNotFoundError）。
    name = name[:120].rstrip(". ")
    return name or "untitled"


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
    # 先截 80 字符再过 safe_name，才能让 safe_name 里的 rstrip 兜底 Windows 静默去掉的尾部 '.' 和 ' '
    paper_name = safe_name(((pa["title_en"] if pa else "paper") or f"paper{paper_id}")[:80])
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
                purge_expired_recycle_items()
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
                deleted = load_deleted()
                deleted_proj_ids = deleted.get("projects", [])
                deleted_folder_ids = deleted.get("folders", [])
                deleted_paper_ids = deleted.get("papers", [])
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
                    folder_sql = "SELECT COUNT(*) c FROM folder WHERE project_id = ?"
                    folder_params: list = [r["id"]]
                    if deleted_folder_ids:
                        folder_sql += " AND id NOT IN ({})".format(",".join("?" for _ in deleted_folder_ids))
                        folder_params += deleted_folder_ids
                    d["folder_count"] = conn.execute(folder_sql, folder_params).fetchone()["c"]
                    paper_sql = """SELECT COUNT(*) c FROM paper pa
                        JOIN folder f ON f.id = pa.folder_id WHERE f.project_id = ?"""
                    paper_params: list = [r["id"]]
                    if deleted_folder_ids:
                        paper_sql += " AND f.id NOT IN ({})".format(",".join("?" for _ in deleted_folder_ids))
                        paper_params += deleted_folder_ids
                    if deleted_paper_ids:
                        paper_sql += " AND pa.id NOT IN ({})".format(",".join("?" for _ in deleted_paper_ids))
                        paper_params += deleted_paper_ids
                    d["paper_count"] = conn.execute(paper_sql, paper_params).fetchone()["c"]
                    projects.append(d)
                json_response(self, {"projects": projects})
            elif path == "/api/projects/tree":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                pid = int((qs.get("id") or [None])[0])
                own = get_db().execute("SELECT id FROM project WHERE id = ? AND user_id = ?", (pid, uid)).fetchone()
                if not own:
                    self._error(404, "项目不存在")
                    return
                if pid in load_deleted().get("projects", []):
                    self._error(404, "项目已移入回收站")
                    return
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
                deleted_project_ids = list(deleted.get("projects", []))
                # 拼装 WHERE
                conds = ["pr.user_id = ?"]
                params: list = [uid]
                if fid:
                    conds.append("pa.folder_id = ?")
                    params.append(int(fid))
                if q:
                    conds.append("(pa.title_en LIKE ? OR pa.title_zh LIKE ? OR pa.authors LIKE ? OR pa.journal LIKE ?)")
                    like = f"%{q}%"
                    params += [like, like, like, like]
                if deleted_paper_ids:
                    conds.append("pa.id NOT IN ({})".format(",".join("?" for _ in deleted_paper_ids)))
                    params += deleted_paper_ids
                if deleted_folder_ids:
                    conds.append("f.id NOT IN ({})".format(",".join("?" for _ in deleted_folder_ids)))
                    params += deleted_folder_ids
                if deleted_project_ids:
                    conds.append("pr.id NOT IN ({})".format(",".join("?" for _ in deleted_project_ids)))
                    params += deleted_project_ids
                sql = """SELECT pa.* FROM paper pa
                    JOIN folder f ON f.id = pa.folder_id
                    JOIN project pr ON pr.id = f.project_id
                    WHERE """ + " AND ".join(conds) + " ORDER BY pa.id DESC"
                rows = conn.execute(sql, params).fetchall()
                papers = []
                for r in rows:
                    d = dict(r)
                    note_filter, note_params = _deleted_filter_clause("notes", "n")
                    notes = conn.execute(
                        f"SELECT n.* FROM note n WHERE n.paper_id = ?{note_filter} ORDER BY n.id",
                        (r["id"], *note_params),
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
                r = conn.execute(
                    """SELECT pa.*, f.project_id AS _project_id FROM paper pa
                       JOIN folder f ON f.id = pa.folder_id
                       JOIN project pr ON pr.id = f.project_id
                       WHERE pa.id = ? AND pr.user_id = ?""",
                    (pid, uid),
                ).fetchone()
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
                if r["_project_id"] in deleted.get("projects", []):
                    self._error(404, "论文所在项目已被删除")
                    return
                d = dict(r)
                d["notes"] = []
                note_filter, note_params = _deleted_filter_clause("notes", "n")
                for n in conn.execute(
                    f"SELECT n.* FROM note n WHERE n.paper_id = ?{note_filter} ORDER BY n.id", (pid, *note_params)
                ).fetchall():
                    nd = dict(n)
                    nd["images"] = [dict(i) for i in conn.execute(
                        "SELECT * FROM image WHERE note_id = ? ORDER BY id", (n["id"],)
                    ).fetchall()]
                    d["notes"].append(nd)
                json_response(self, {"paper": d})
            elif path == "/api/recycle":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                items, summary = list_recycle_items(uid)
                json_response(self, {"items": items, "summary": summary, "retention_days": RECYCLE_RETENTION_DAYS})
            elif path == "/api/note_versions":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                conn = get_db()
                now = _recycle_now()
                # 清理过期历史版本（串行化写操作，避免并发 database is locked）
                with DB_LOCK:
                    conn.execute("DELETE FROM note_version WHERE expires_at <= ?", (now.isoformat(timespec="seconds"),))
                    conn.commit()
                rows = conn.execute(
                    """SELECT nv.id, nv.note_id, nv.content, nv.image_ids_json, nv.created_at, nv.expires_at,
                              n.created_at note_created_at,
                              pa.id paper_id, pa.title_en paper_title_en, pa.title_zh paper_title_zh,
                              p.id project_id, p.name project_name,
                              f.id folder_id
                       FROM note_version nv
                       JOIN note n ON n.id = nv.note_id
                       JOIN paper pa ON pa.id = n.paper_id
                       JOIN folder f ON f.id = pa.folder_id
                       JOIN project p ON p.id = f.project_id
                       WHERE p.user_id = ? AND nv.expires_at > ?
                       ORDER BY nv.created_at DESC""",
                    (uid, now.isoformat(timespec="seconds")),
                ).fetchall()
                versions = []
                for r in rows:
                    remain_seconds = max(0, int((datetime.fromisoformat(r["expires_at"]) - now).total_seconds()))
                    remaining_days = max(1, (remain_seconds + 86399) // 86400) if remain_seconds else 0
                    versions.append({
                        "id": r["id"],
                        "note_id": r["note_id"],
                        "content": r["content"],
                        "image_ids": json.loads(r["image_ids_json"] or "[]"),
                        "created_at": r["created_at"],
                        "expires_at": r["expires_at"],
                        "remaining_days": remaining_days,
                        "note_created_at": r["note_created_at"],
                        "paper_id": r["paper_id"],
                        "paper_title": r["paper_title_en"] or r["paper_title_zh"] or "（未命名论文）",
                        "project_id": r["project_id"],
                        "project_name": r["project_name"],
                        "folder_id": r["folder_id"],
                        "folder_path": _folder_path(conn, r["folder_id"]),
                    })
                conn.commit()
                json_response(self, {"versions": versions, "retention_days": RECYCLE_RETENTION_DAYS})
            else:
                self._error(404, "Not Found")
        except Exception as e:
            self._error(500, str(e))

    def do_POST(self):
        with DB_LOCK:
            self._do_POST_locked()

    def _do_POST_locked(self):
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
                    token = auth[7:].strip()
                    conn = get_db()
                    conn.execute("DELETE FROM session WHERE token = ?", (token,))
                    conn.commit()
                json_response(self, {"ok": True})
            # ===== 批量软删除 + 恢复（仿照论文观察台 data/deleted.json）=====
            elif path == "/api/projects/delete":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                ids = [int(x) for x in (_read_json_body(self).get("ids") or []) if x]
                added = move_to_recycle(uid, "project", ids)
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 个项目"})
            elif path == "/api/folders/delete":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                ids = [int(x) for x in (_read_json_body(self).get("ids") or []) if x]
                added = move_to_recycle(uid, "folder", ids)
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 个文件夹"})
            elif path == "/api/papers/delete":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                ids = [int(x) for x in (_read_json_body(self).get("ids") or []) if x]
                added = move_to_recycle(uid, "paper", ids)
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 篇论文"})
            elif path == "/api/deleted/clear":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                restored = restore_recycle_items(uid)
                json_response(self, {"ok": True, "restored": restored, "message": f"已恢复 {restored} 项"})
            elif path == "/api/recycle/restore":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                ids = [int(x) for x in (_read_json_body(self).get("ids") or []) if x]
                restored = restore_recycle_items(uid, ids)
                json_response(self, {"ok": True, "restored": restored, "message": f"已恢复 {restored} 项"})
            elif path == "/api/recycle/purge":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                ids = [int(x) for x in (_read_json_body(self).get("ids") or []) if x]
                purged = purge_recycle_items(uid, ids)
                json_response(self, {"ok": True, "purged": purged, "message": f"已永久删除 {purged} 项"})
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
                project = conn.execute("SELECT id FROM project WHERE id = ? AND user_id = ?", (project_id, uid)).fetchone()
                if not project:
                    self._error(404, "项目不存在")
                    return
                if parent_id:
                    parent = conn.execute("SELECT id FROM folder WHERE id = ? AND project_id = ?", (parent_id, project_id)).fetchone()
                    if not parent:
                        self._error(400, "父文件夹不存在")
                        return
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
                folder = conn.execute(
                    """SELECT f.id FROM folder f JOIN project p ON p.id = f.project_id
                       WHERE f.id = ? AND p.user_id = ?""",
                    (folder_id, uid),
                ).fetchone()
                if not folder:
                    self._error(404, "文件夹不存在")
                    return
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
            elif path == "/api/note_versions/revert":
                uid = require_user(self)
                if not uid:
                    self._error(401, "未登录")
                    return
                body = _read_json_body(self)
                note_id = int(body.get("note_id"))
                version_id = int(body.get("version_id"))
                conn = get_db()
                note = conn.execute(
                    """SELECT n.id, n.content FROM note n
                       JOIN paper pa ON pa.id = n.paper_id
                       JOIN folder f ON f.id = pa.folder_id
                       JOIN project p ON p.id = f.project_id
                       WHERE n.id = ? AND p.user_id = ?""",
                    (note_id, uid),
                ).fetchone()
                if not note:
                    self._error(404, "思考不存在")
                    return
                version = conn.execute(
                    "SELECT content FROM note_version WHERE id = ? AND note_id = ?",
                    (version_id, note_id),
                ).fetchone()
                if not version:
                    self._error(404, "历史版本不存在")
                    return
                # 先把当前内容与图片快照存为新版本，再回退
                current_images = [r["id"] for r in conn.execute("SELECT id FROM image WHERE note_id = ? ORDER BY id", (note_id,)).fetchall()]
                current_img_re = re.compile(r"\[\[img:(\d+)\]\]")
                seen_img = set()
                current_image_ids = []
                for m in current_img_re.finditer(note["content"]):
                    idx = int(m.group(1))
                    if 0 <= idx < len(current_images):
                        iid = current_images[idx]
                        if iid not in seen_img:
                            seen_img.add(iid)
                            current_image_ids.append(iid)
                expires = (datetime.utcnow() + timedelta(days=RECYCLE_RETENTION_DAYS)).isoformat()
                conn.execute(
                    "INSERT INTO note_version (note_id, content, image_ids_json, created_at, expires_at) VALUES (?,?,?,?,?)",
                    (note_id, note["content"], json.dumps(current_image_ids), now_iso(), expires),
                )
                conn.execute("UPDATE note SET content = ? WHERE id = ?", (version["content"], note_id))
                conn.commit()
                json_response(self, {"ok": True})
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
        with DB_LOCK:
            self._do_PUT_locked()

    def _do_PUT_locked(self):
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
                       publish_date=?, doi=?, url=?, local_path=? WHERE id=? AND folder_id IN
                       (SELECT f.id FROM folder f JOIN project p ON p.id = f.project_id WHERE p.user_id = ?)""",
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
                        uid,
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
                content = body.get("content", "")
                new_images = body.get("images", [])
                conn = get_db()
                note = conn.execute(
                    """SELECT n.id, n.content, n.paper_id, f.project_id
                       FROM note n
                       JOIN paper pa ON pa.id = n.paper_id
                       JOIN folder f ON f.id = pa.folder_id
                       JOIN project p ON p.id = f.project_id
                       WHERE n.id = ? AND p.user_id = ?""",
                    (nid, uid),
                ).fetchone()
                if not note:
                    self._error(404, "思考不存在")
                    return

                # 保存当前版本到历史（记录内容 + 当前内容引用的图片 ID 顺序）
                current_images = [r["id"] for r in conn.execute("SELECT id FROM image WHERE note_id = ? ORDER BY id", (nid,)).fetchall()]
                current_img_re = re.compile(r"\[\[img:(\d+)\]\]")
                seen_img = set()
                current_image_ids = []
                for m in current_img_re.finditer(note["content"]):
                    idx = int(m.group(1))
                    if 0 <= idx < len(current_images):
                        iid = current_images[idx]
                        if iid not in seen_img:
                            seen_img.add(iid)
                            current_image_ids.append(iid)
                expires = (datetime.utcnow() + timedelta(days=RECYCLE_RETENTION_DAYS)).isoformat()
                conn.execute(
                    "INSERT INTO note_version (note_id, content, image_ids_json, created_at, expires_at) VALUES (?,?,?,?,?)",
                    (nid, note["content"], json.dumps(current_image_ids), now_iso(), expires),
                )

                # 解析新内容中的图片占位符：保留的现有图 [[existing-img:ID]] 和新图 [[img:IDX]]
                placeholder_re = re.compile(r"\[\[(?:existing-img:(\d+)|img:(\d+))\]\]")
                kept_image_ids = []
                for m in placeholder_re.finditer(content):
                    if m.group(1):
                        kept_image_ids.append(int(m.group(1)))

                # 验证保留的图片确实属于本条思考
                valid_ids = set()
                if kept_image_ids:
                    placeholders = ",".join("?" for _ in kept_image_ids)
                    valid_rows = conn.execute(
                        f"SELECT id FROM image WHERE note_id = ? AND id IN ({placeholders})",
                        (nid, *kept_image_ids),
                    ).fetchall()
                    valid_ids = {r["id"] for r in valid_rows}

                # 删除未被引用的现有图片（文件 + 记录）
                all_image_ids = [r["id"] for r in conn.execute("SELECT id FROM image WHERE note_id = ?", (nid,)).fetchall()]
                for iid in all_image_ids:
                    if iid not in valid_ids:
                        img = conn.execute("SELECT file_path FROM image WHERE id = ?", (iid,)).fetchone()
                        if img:
                            try:
                                Path(img["file_path"]).unlink(missing_ok=True)
                            except Exception:
                                pass
                        conn.execute("DELETE FROM image WHERE id = ?", (iid,))

                # 按内容顺序重建图片列表，并生成最终 content
                image_id_to_idx = {}
                new_idx_map = {}
                output = []
                last = 0
                for m in placeholder_re.finditer(content):
                    output.append(content[last:m.start()])
                    if m.group(1):
                        iid = int(m.group(1))
                        if iid in valid_ids:
                            image_id_to_idx.setdefault(iid, len(image_id_to_idx))
                            output.append(f"[[img:{image_id_to_idx[iid]}]]")
                    else:
                        idx = int(m.group(2))
                        if idx not in new_idx_map:
                            img_data = new_images[idx] if idx < len(new_images) else {}
                            inserted = store_image(note["project_id"], note["paper_id"], nid, img_data.get("data", ""), img_data.get("ext", "png"))
                            new_idx_map[idx] = inserted["id"]
                        iid = new_idx_map[idx]
                        image_id_to_idx.setdefault(iid, len(image_id_to_idx))
                        output.append(f"[[img:{image_id_to_idx[iid]}]]")
                    last = m.end()
                output.append(content[last:])
                final_content = "".join(output)

                conn.execute("UPDATE note SET content = ? WHERE id = ?", (final_content, nid))
                conn.commit()
                json_response(self, {"ok": True})
            else:
                self._error(404, "Not Found")
        except Exception as e:
            self._error(500, str(e))

    def do_DELETE(self):
        with DB_LOCK:
            self._do_DELETE_locked()

    def _do_DELETE_locked(self):
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
                added = move_to_recycle(uid, "project", [pid])
                json_response(self, {"ok": True, "deleted": added, "message": "已删除项目（可在回收站恢复）"})
                return
            if path == "/api/folders":
                fid = int((qs.get("id") or [None])[0])
                added = move_to_recycle(uid, "folder", [fid])
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 个文件夹（可在回收站恢复）"})
                return
            if path == "/api/papers":
                pid = int((qs.get("id") or [None])[0])
                added = move_to_recycle(uid, "paper", [pid])
                json_response(self, {"ok": True, "deleted": added, "message": "已删除论文（可在回收站恢复）"})
                return
            if path == "/api/notes":
                # 支持单条 id 或批量 ids（逗号分隔或重复参数）
                raw_parts = qs.get("id") or qs.get("ids") or []
                ids = sorted({int(x.strip()) for part in raw_parts for x in part.split(",") if x.strip()})
                if not ids:
                    self._error(400, "缺少 id")
                    return
                added = move_to_recycle(uid, "note", ids)
                json_response(self, {"ok": True, "deleted": added, "message": f"已删除 {added} 条思考（可在回收站恢复）"})
                return
            if path == "/api/notes/images":
                iid = int((qs.get("id") or [None])[0])
                conn = get_db()
                img = conn.execute(
                    """SELECT i.* FROM image i JOIN note n ON n.id = i.note_id
                       JOIN paper pa ON pa.id = n.paper_id JOIN folder f ON f.id = pa.folder_id
                       JOIN project p ON p.id = f.project_id WHERE i.id = ? AND p.user_id = ?""",
                    (iid, uid),
                ).fetchone()
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
    migrate_legacy_deleted_index()
    purge_expired_recycle_items()
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
