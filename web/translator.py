#!/usr/bin/env python3
"""
文章标题中文翻译模块。

多引擎策略：
  1. Google Translate（deep_translator）— 需要能访问 translate.google.com 或配置代理
  2. MyMemory 免费 API — 国内直连，无需认证，每日 1000 次免费

带本地 JSON 缓存避免重复请求。所有引擎失败时返回原文，不阻断主流程。

用法：
    from translator import translate_title, translate_batch

    zh = translate_title("Local molecular motions encode time-resolved infrared spectra of proteins")
    # → "局部分子运动编码蛋白质的时间分辨红外光谱"

    results = translate_batch(["title1", "title2", ...])
    # → {"title1": "翻译1", "title2": "翻译2"}
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import threading
import urllib.request
import urllib.parse
from pathlib import Path

logger = logging.getLogger(__name__)

# 缓存文件路径（放 data 目录下，不入 git）
CACHE_DIR = Path(__file__).resolve().parent.parent / "data"
CACHE_FILE = CACHE_DIR / ".translation_cache.json"

# 翻译缓存：内存字典 + 文件持久化
_cache: dict[str, str] = {}
_cache_loaded = False
_cache_lock = threading.Lock()

# 请求间隔（秒），避免被限流
_MIN_INTERVAL = 0.5
_last_request_time = 0.0
_time_lock = threading.Lock()

# ===== 代理配置（从环境变量读取）=====
_proxies: dict | None = None


def _init_proxies() -> dict | None:
    """从环境变量或 config.json 读取 HTTP/HTTPS 代理。"""
    global _proxies
    if _proxies is not None:
        return _proxies

    # 优先环境变量
    http_proxy = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    https_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")

    if http_proxy or https_proxy:
        _proxies = {"http": http_proxy, "https": https_proxy}
        return _proxies

    # 其次尝试 config.json
    try:
        cfg_path = CACHE_DIR.parent / "config" / "config.json"
        if cfg_path.exists():
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            px = cfg.get("proxy")
            if isinstance(px, str) and px.strip():
                _proxies = {"http": px.strip(), "https": px.strip()}
                return _proxies
            elif isinstance(px, dict):
                _proxies = {k: v for k, v in px.items() if v}
                return _proxies if _proxies else None
    except Exception:
        pass

    _proxies = {}  # 空字典表示已检查过但无代理
    return None


def _load_cache() -> None:
    """从磁盘加载翻译缓存。"""
    global _cache_loaded, _cache
    with _cache_lock:
        if _cache_loaded:
            return
        if CACHE_FILE.exists():
            try:
                with open(CACHE_FILE, "r", encoding="utf-8") as f:
                    _cache = json.load(f)
                logger.debug(f"已加载翻译缓存：{len(_cache)} 条")
            except Exception as e:
                logger.warning(f"读取翻译缓存失败：{e}，将新建")
                _cache = {}
        else:
            _cache = {}
        _cache_loaded = True


def _save_cache() -> None:
    """将翻译缓存写回磁盘。"""
    with _cache_lock:
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(_cache, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"保存翻译缓存失败：{e}")


def _strip_html_tags(text: str) -> str:
    """去除 HTML 标签，保留文本内容。"""
    return re.sub(r"<[^>]+>", "", text).strip()


# 引擎顺序：国内 MyMemory 直连稳定，Google 在国内常被墙（实测 43 秒才超时）。
# 因此先打 MyMemory，再退到 Google；Google 加 3 秒硬超时，绝不卡死。
_ENGINE_ORDER = ("mymemory", "google")

# 引擎超时（秒）——避免 Google 在国内挂 40+ 秒拖慢识别
_ENGINE_TIMEOUTS = {"google": 3, "mymemory": 8}


# ===== 引擎 1：MyMemory 免费 API（国内可用，速度快，优先）=====
def _translate_mymemory(title: str) -> str | None:
    """使用 MyMemory 免费 API 翻译。返回 None 表示失败。

    无需认证，免费额度 1000 次/天。
    文档: https://mymemory.translated.net/doc/spec.php
    """
    try:
        # 限流
        global _last_request_time
        with _time_lock:
            elapsed = time.time() - _last_request_time
            if elapsed < _MIN_INTERVAL:
                time.sleep(_MIN_INTERVAL - elapsed)
            _last_request_time = time.time()

        clean_title = _strip_html_tags(title)
        params = urllib.parse.urlencode({
            "q": clean_title,
            "langpair": "en|zh-CN",
        })
        url = f"https://api.mymemory.translated.net/get?{params}"

        req = urllib.request.Request(url)
        req.add_header("User-Agent", "PaperObservatory/1.0")

        # 设置代理
        px = _init_proxies()
        handler = None
        if px and px.get("https"):
            handler = urllib.request.ProxyHandler(px)
            opener = urllib.request.build_opener(handler)
        else:
            opener = urllib.request.build_opener()

        with opener.open(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        status = data.get("responseStatus", 0)
        if status != 200:
            logger.debug(f"MyMemory 返回状态 {status}")
            return None

        translated = data.get("responseData", {}).get("translatedText", "")
        if translated and translated.strip() and translated.lower() != clean_title.lower():
            return translated.strip()
        return None
    except Exception as e:
        logger.debug(f"MyMemory 翻译失败 [{title[:40]}...]: {e}")
        return None


# ===== 引擎 2：Google Translate（仅在 MyMemory 失败时回退；硬超时）=====
def _translate_google(title: str) -> str | None:
    """使用 deep_translator (Google) 翻译。带 3 秒硬超时。返回 None 表示不可用。"""
    try:
        from deep_translator import GoogleTranslator

        # 限流
        global _last_request_time
        with _time_lock:
            elapsed = time.time() - _last_request_time
            if elapsed < _MIN_INTERVAL:
                time.sleep(_MIN_INTERVAL - elapsed)
            _last_request_time = time.time()

        proxy_args = {}
        px = _init_proxies()
        if px and px.get("http"):
            proxy_args["proxies"] = px

        # socket_timeout=3 防止国内被墙时挂几十秒
        try:
            translator = GoogleTranslator(source="en", target="zh-CN", socket_timeout=_ENGINE_TIMEOUTS["google"], **proxy_args)
        except TypeError:
            # 老版本可能没有 socket_timeout
            translator = GoogleTranslator(source="en", target="zh-CN", **proxy_args)

        result = translator.translate(title)

        if result and result.strip() and result != title:
            return result.strip()
        return None
    except Exception as e:
        logger.debug(f"Google 翻译失败 [{title[:40]}...]: {e}")
        return None


def translate_title(title: str) -> str:
    """翻译单条标题（多引擎自动降级）。

    Args:
        title: 英文标题（可含 HTML 标签）

    Returns:
        中文翻译；所有引擎失败时返回原文
    """
    if not title or not title.strip():
        return title

    title = title.strip()

    # 检查缓存
    _load_cache()
    with _cache_lock:
        cached = _cache.get(title)
        if cached:
            return cached

    # 已经包含中文的标题（公众号文章可能本来就是中文），跳过
    chinese_chars = sum(1 for ch in title if "\u4e00" <= ch <= "\u9fff")
    if len(title) > 0 and chinese_chars / len(title) > 0.2:
        with _cache_lock:
            _cache[title] = title
        _save_cache()
        return title

    # 按 _ENGINE_ORDER 顺序试引擎：先 MyMemory（国内可用），后 Google（可能被墙）
    engines = {
        "google": _translate_google,
        "mymemory": _translate_mymemory,
    }
    result = None
    for name in _ENGINE_ORDER:
        fn = engines.get(name)
        if not fn:
            continue
        result = fn(title)
        if result:
            break

    # 所有引擎都失败，返回原文
    if not result:
        result = title

    # 写入缓存
    with _cache_lock:
        _cache[title] = result
    _save_cache()

    return result


def translate_batch(titles: list[str]) -> dict[str, str]:
    """批量翻译（自动去重）。

    Args:
        titles: 英文标题列表

    Returns:
        {原文: 译文} 字典
    """
    unique = list(dict.fromkeys(titles))  # 去重保序
    results: dict[str, str] = {}

    for title in unique:
        results[title] = translate_title(title)

    return results


# CLI 测试入口
if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    test_titles = [
        "Local molecular motions encode time-resolved infrared spectra of proteins",
        "Blinking membrane patterns induced by protein binding/unbinding",
        "Substrate-Directed Wetting Layers in Bicontinuous Particle-Stabilised Emulsions",
        "Interface-shrunk regulated synthesis of asymmetric ultrafine mono-mesopore <i>Nepenthes</i> with tailored window",
        "Membrane fouling control in reverse osmosis desalination",
    ]
    print("=== 翻译测试 ===")
    for t in test_titles:
        zh = translate_title(t)
        print(f"EN: {t}")
        print(f"ZH: {zh}")
        print()
