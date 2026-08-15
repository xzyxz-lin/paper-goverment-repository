# 私人文献库 / Private Library

一个**本地私有**的论文阅读与思考管理工具。把读过的论文按「项目 → 无限嵌套文件夹」组织起来，记录每篇论文的元信息（期刊 / 作者 / 中英文标题 / 日期 / DOI），并随手记下它带给你的**思考**——文字或截图都可以。

界面完全复用「推送公众号论文」项目的视觉框架（墨色 + 纸面 + 氧化绿 + 铜橙配色、抽屉、卡片、动画），风格一致。

## 核心定位

> PDF 原文不存进库里。库里存的是**元信息 + 一条指向你电脑里真实 PDF 的路径**，随时一键跳回原文件。真正沉淀下来的是「这篇文章对我有什么用」——那才是写论文做引用时最难的部分。

## 功能

| 功能 | 说明 |
|------|------|
| 账号系统 | 注册 / 登录，本地 token，数据隔离 |
| 项目管理 | 一个课题一个项目，可写备注 |
| 无限嵌套文件夹 | 文件夹里可以继续建文件夹，也可放论文 |
| 论文录入（3 种） | 拖入 PDF 自动解析、点选本地 PDF、手动填写 |
| 元信息展示 | 英文标题 + 中文标题（自动翻译）+ 期刊 + 作者 + 发表日期 + DOI |
| 期刊识别 | DOI 前缀映射表优先（j.watres→Water Research 等），覆盖常读期刊 |
| 中文标题自动翻译 | 复用 translator（Google + MyMemory 双引擎），提取后自动填中文标题 |
| 本地路径自动定位 | 拖入 PDF 后按文件名在论文目录搜索同名文件，自动填路径（可改） |
| 思考标注（图文混排） | 富文本编辑区：文字 + 多张截图 + 图间插话 + 换行缩进，点「保存思考」才提交为一条 |
| 截图粘贴 | 编辑区 `Ctrl+V` 粘贴到光标处，存到 `picture asset/` |
| 本地跳转 | 「打开 PDF」直接打开原文件，「打开所在文件夹」定位文件 |
| 批量删除（软删，可恢复） | 论文/文件夹/项目前都有 checkbox；勾选后底部浮现工具条，可批量删除。删除项记入 `data/deleted.json`，侧边栏「回收站 / 恢复全部」一键还原 |

## 目录结构

```
私人文献库/
├── web/
│   ├── library.py          # 后端（标准库 + sqlite3 + pdfplumber）
│   ├── library.html        # 前端页面
│   ├── library.css         # 样式（复用观察台配色）
│   ├── library.js          # 前端交互
│   ├── start_web.cmd       # 启动入口（cmd）
│   └── start_web.ps1       # 启动脚本（健康检查 + 开浏览器）
├── data/
│   └── library.db          # SQLite 数据库（自动创建）
├── picture asset/          # 截图资产（按 项目/论文 分层）
└── .venv/                  # Python 虚拟环境（含 pdfplumber/pypdf）
```

## 快速开始

### 首次安装依赖

```powershell
cd A:\workbuddy项目\私人文献库
python -m venv .venv
.venv\Scripts\pip install pdfplumber pypdf
```

### 启动

双击 `web\start_web.cmd`，或：

```powershell
cd web
powershell -ExecutionPolicy Bypass -File start_web.ps1
```

浏览器自动打开 `http://127.0.0.1:8040`，首次使用先「注册一个」账号。

## 使用流程

1. **注册登录** → 创建自己的账号
2. **新建项目** → 右上角「新建项目」，如「反渗透膜隔网 CFD」
3. **建文件夹** → 项目内左侧「文件夹树」可无限建子文件夹
4. **导入论文** → 右上角「导入论文」：
   - 拖入本地 PDF，自动提取标题 / 作者 / 期刊 / 日期 / DOI，核对后保存
   - 也可手动填写，并填「本地 PDF 路径」以便一键跳转
5. **记思考** → 点开论文，在「我的思考」区写文字，或直接 `Ctrl+V` 粘贴截图
6. **写论文时** → 点「打开 PDF」跳回原文，「打开所在文件夹」定位文件

## 局域网 / Zerotier 访问

后端默认监听 `0.0.0.0`，同一 Zerotier 网络内的其它设备可通过 `http://10.44.55.169:8040` 访问。

首次使用需放行 Windows 防火墙（需管理员权限，一次即可）：

1. 双击 `web\run_zerotier_admin.bat`
2. 弹出的 UAC 窗口点「是」
3. 脚本自动创建「Private Library ZeroTier 8040」入站规则，仅允许 `10.44.55.0/24` 网段访问

> 也可手动：右键 PowerShell「以管理员身份运行」→ `powershell -ExecutionPolicy Bypass -File web\enable_zerotier_access.ps1`

## PDF 元信息提取

后端用 `pdfplumber` 解析 PDF 首页，启发式提取：

| 字段 | 提取方式 | 可靠性 |
|------|----------|--------|
| 标题 | 首页最大字号文本块（自动剔除页眉期刊名） | 高 |
| DOI | 正则 `10.xxxx/…` | 高 |
| 发表日期 | `Received/Accepted/Available online/© 年份`（兼容两种日期格式） | 中 |
| 期刊名 | **DOI 前缀映射表优先**（j.watres→Water Research 等），兜底页眉卷号行/版权行 | 高 |
| 作者 | 标题下方姓名行 | 中 |
| 中文标题 | 自动翻译（Google + MyMemory 双引擎 + 缓存） | 高（联网时） |

> 主流文字版 PDF 提取稳定；**扫描版（无文字层）暂不支持**，需要 OCR（后续可加）。所有字段保存前都可手动修改。

## 数据与隐私

- 全部数据存本地 `data/library.db`（SQLite）与 `picture asset/` 目录
- 无任何联网上传，账号密码本地 PBKDF2 哈希存储
- 端口 `8040`，监听 `0.0.0.0`（本机 + Zerotier 局域网均可访问，防火墙规则控制来源）

## 技术要点

- 后端：`BaseHTTPRequestHandler` + `ThreadingHTTPServer`（纯标准库），沿用观察台架构
- 数据库：`sqlite3` 标准库，外键级联删除（删文件夹自动删论文、删论文自动删标注与图片记录）
- 无限嵌套：`folder.parent_id` 自引用，前端递归渲染文件夹树
- 截图：前端 `paste` 事件捕获剪贴板图片 → base64 → 后端存 `picture asset/<项目>/<论文>/`
- 本地跳转：后端 `os.startfile` 打开 PDF / `explorer /select` 定位文件

## 待办（后续可扩展）

- [ ] 扫描版 PDF 的 OCR 提取
- [ ] 论文元信息的中文标题自动翻译
- [ ] 拖拽移动论文到其它文件夹
- [ ] 标签 / 关键词系统
- [ ] 导出引用（BibTeX / EndNote）

## 删除与回收（2026-08 新增）

仿照「论文观察台」的 `data/deleted.json` 软删除模式：

- 每行 / 卡片前有 checkbox，勾选后底部浮现 `bulk-delete-bar`
- 工具条：删除选中 / 取消选择
- 批量删除调 `POST /api/{projects,folders,papers}/delete`（按 ids）
- 索引文件 `data/deleted.json`：`{"projects": [...], "folders": [...], "papers": [...]}`
- 列表接口（`/api/projects`、`/api/projects/tree`、`/api/papers`、`/api/paper`）自动过滤已软删项
- 侧边栏底部「回收站 / 恢复全部」调 `POST /api/deleted/clear` 清空索引 = 全部恢复
