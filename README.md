# 长剧本角色卡与人物关系 Agent

这是一个可以实际运行的长剧本分析原型。它不会一次把整本剧本塞给模型，而是：

1. 在本地把剧本切成场景；
2. 逐场提取角色说过的话、做过的事、别人对他的评价和原文证据；
3. 按角色和人物对建立连续时间线；
4. 分阶段判断稳定性格、暂时状态、潜在变化和确认变化；
5. 对比剧情阶段、分析节奏、追踪性格画像变化和关系突破；
6. 生成角色卡、成长弧线、可切换阶段的动态关系图和信息差台账；
7. 按需实时检索 TikTok 热点，生成三套可拍短视频素材；
8. 把所有 AI 判断放进编剧审核队列，人工确认后才能成为正式设定。

## 先看保密边界

`prepare` 命令完全在本机运行，不会上传剧本。`analyze` 会把剧本片段发送给配置的模型 API。对公司未公开剧本执行 `analyze` 前，必须先确认公司允许使用对应服务、账号和数据区域。

运行目录里会保存剧本文本、证据摘录和分析结果，也应按公司内部材料管理。

## 安装

需要 Python 3.9 或更高版本。

```bash
cd "script-character-agent"
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

确认获得使用许可后，在当前终端设置 API 密钥：

```bash
export OPENAI_API_KEY="你的密钥"
```

密钥不会写入项目文件。模型调用使用 Responses API 的 Structured Outputs，让每次输出遵循固定 JSON 结构。默认逐场提取使用 `gpt-6-luna`，最终角色与关系汇总使用 `gpt-6.1-sol`；也可以在命令中覆盖。接口与模型选择依据 [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 和 [模型目录](https://developers.openai.com/api/docs/models)。

## 使用

### 网页版（推荐）

本地网页把上传、免费切分、全剧快速概览、完整分析、版本对比、动态关系图、TikTok 素材和结果审核放在同一个界面中。API Key 只由本机后端读取，不会出现在网页代码里。

```bash
cd "script-character-agent"
.venv/bin/python -m script_agent serve
```

浏览器打开：

```text
http://127.0.0.1:8000/
```

网页默认只监听本机地址。点击“免费切分并预览”不会调用模型；只有确认数据权限并点击 AI 分析后，剧本片段才会发送给模型 API。

上传新剧本时，可以在“这是已有剧本的新版本吗？”中选择上一份档案。完成深度分析后，“剧情与节奏”页会显示新增、删减、人物、关系和节奏变化。

“TikTok 素材”是独立的人工触发步骤。每次生成都会进行新的网页检索，并输出安全传播版、大胆暧昧版和争议讨论版。网页会显示热点来源；素材不会自动发布。未确认角色均为成年人时，大胆版只使用冲突和悬念，不生成暧昧擦边内容。

### 1. 先在本地检查切分效果

```bash
python3 -m script_agent prepare "/路径/剧本.docx" --output runs/同居演员守则
```

检查：

```text
runs/同居演员守则/source/scenes.json
```

支持 TXT、Markdown、Fountain、PDF 和 DOCX。扫描版 PDF 需要先做 OCR。

### 2. 执行完整分析

```bash
python3 -m script_agent analyze "/路径/剧本.docx" --output runs/同居演员守则
```

如果中途停止，使用同一个运行目录继续：

```bash
python3 -m script_agent resume runs/同居演员守则
```

已经完成且输入未变化的场景会直接读取缓存，不会重复付费。只有使用 `--force` 才会全部重新分析。

长剧本可以调整阶段大小，例如每 16 个相关场景做一次阶段汇总：

```bash
python3 -m script_agent resume runs/同居演员守则 --window-scenes 16
```

### 3. 查看和审核

完成后主要查看：

- `output/report.html`：角色卡、成长弧线、关系档案、关系图、信息差和编剧审核界面；
- `output/report.md`：便于复制进文档的文字版；
- `output/report.json`：以后接网站或内容系统的结构化数据；
- `output/relationship-graph.json`：关系图节点、连线和阶段数据；
- `output/knowledge-ledger.json`：谁知道什么、用户是否已经看到；
- `output/review-queue.json`：需要编剧确认的判断。
- `output/tiktok-content.json`：最近一次热点检索与三套短视频素材；仅在主动生成后出现。

审核页中的选择会保存在当前浏览器，也可以导出 `editor-review.json`。AI 生成程序会强制把未经人工确认的“正式设定”降回“人物理解”，避免模型自己批准自己。

## 性格变化是怎么连起来的

系统保留三层材料：

```text
原始场景证据 → 每 12 个相关场景的阶段档案 → 完整角色成长弧线
```

新信息不会覆盖旧信息。每个阶段都保存开始状态、结束状态、反例、触发事件和证据编号。一次反常行为只会标记为“异常行为”；跨场景重复出现或存在明确转折时，才允许升级为“确认变化”。

角色关系采用同样方法，并分别记录 A 如何理解 B、B 如何理解 A、谁更主动、谁掌握信息，以及用户当前能看到哪一层真相。关系图用线条粗细表示强度、箭头表示方向、颜色表示新增/升级/弱化/破裂，并可按已识别阶段切换。

## 海报衔接

角色卡里包含 `poster_brief`，把已找到证据的第一印象、表情、姿态、服装道具、色彩和文案语气转成待审视觉建议。它不会在角色卡尚未确认时直接生成正式海报，也不会补写剧本没有提供的服装或背景。角色卡确认后，可以再把这个 brief 交给设计或图像生成流程。

## 分享与部署说明

分享项目时不要包含 `.env`、`.venv` 或 `runs`。其中 `.env` 可能保存 API 密钥，`runs` 会保存上传的剧本、证据摘录和分析结果。接收方应使用自己的 API 密钥，并在确认剧本数据权限后再执行 AI 分析。

首次使用建议先运行 `prepare` 或在网页中点击“免费切分并预览”，确认场景切分正确后再调用模型。
