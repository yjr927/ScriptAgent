from __future__ import annotations

import argparse
import cgi
import json
import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlparse

from .pipeline import (
    AnalysisConfig,
    analyze_character_profile,
    analyze_quick_preview,
    analyze_run,
    analyze_tiktok_content,
    prepare_script,
    read_json,
    write_json,
)


PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_ROOT = PROJECT_ROOT / "web"
RUNS_ROOT = PROJECT_ROOT / "runs" / "web"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".txt", ".md", ".fountain", ".screenplay", ".pdf", ".docx"}
DOWNLOAD_FILES = {
    "report.html": "text/html; charset=utf-8",
    "report.md": "text/markdown; charset=utf-8",
    "report.json": "application/json; charset=utf-8",
    "relationship-graph.json": "application/json; charset=utf-8",
    "knowledge-ledger.json": "application/json; charset=utf-8",
    "review-queue.json": "application/json; charset=utf-8",
    "tiktok-content.json": "application/json; charset=utf-8",
}


def _load_local_env() -> None:
    path = PROJECT_ROOT / ".env"
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def _safe_error(error: BaseException) -> str:
    message = str(error) or error.__class__.__name__
    return re.sub(r"sk-[A-Za-z0-9_-]+", "[密钥已隐藏]", message)


def _safe_filename(filename: str) -> str:
    name = Path(filename or "script.txt").name
    cleaned = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "-", name, flags=re.UNICODE).strip("-.")
    return cleaned[:120] or "script.txt"


def _new_run_id(filename: str) -> str:
    stem = re.sub(r"[^a-zA-Z0-9]+", "-", Path(filename).stem).strip("-").lower()[:28]
    prefix = datetime.now().strftime("%Y%m%d-%H%M%S")
    return "{}-{}-{}".format(prefix, stem or "script", uuid.uuid4().hex[:6])


def _resolve_run(run_id: str) -> Path:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{4,120}", run_id or ""):
        raise ValueError("运行编号不正确。")
    root = RUNS_ROOT.resolve()
    path = (root / run_id).resolve()
    if path.parent != root:
        raise ValueError("运行目录不正确。")
    return path


def _run_summary(run_dir: Path) -> Dict[str, Any]:
    manifest_path = run_dir / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError("还没有完成剧本切分。")
    manifest = read_json(manifest_path)
    report_path = run_dir / "output" / "report.json"
    report_meta: Dict[str, Any] = {}
    if report_path.exists():
        report_meta = read_json(report_path).get("meta", {})
    return {
        "run_id": run_dir.name,
        "source_name": manifest.get("source_name", "未命名剧本"),
        "scene_count": manifest.get("scene_count", 0),
        "prepared_at": manifest.get("prepared_at", ""),
        "has_report": report_path.exists(),
        "last_analysis": report_meta,
        "previous_run_id": manifest.get("previous_run_id", ""),
        "version_number": manifest.get("version_number", 1),
    }


class JobStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: Dict[str, Dict[str, Any]] = {}

    def create(self, kind: str, run_id: str, message: str) -> Dict[str, Any]:
        now = time.time()
        job = {
            "id": uuid.uuid4().hex,
            "kind": kind,
            "run_id": run_id,
            "status": "queued",
            "progress": 0,
            "message": message,
            "logs": [message],
            "error": "",
            "result": {},
            "started_at": now,
            "updated_at": now,
        }
        with self._lock:
            self._jobs[job["id"]] = job
        return dict(job)

    def update(self, job_id: str, *, message: str, progress: Optional[int] = None) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job["status"] = "running"
            job["message"] = message
            job["updated_at"] = time.time()
            if progress is not None:
                job["progress"] = max(job["progress"], min(99, int(progress)))
            if not job["logs"] or job["logs"][-1] != message:
                job["logs"] = (job["logs"] + [message])[-30:]

    def progress_message(self, job_id: str, message: str) -> None:
        progress = None
        quick_steps = {
            "正在读取全剧": 12,
            "正在生成一句话": 42,
            "正在本机整理角色": 86,
            "一分钟概览已生成": 98,
            "正在检索近期 TikTok": 18,
            "正在保存三套短视频": 88,
            "TikTok 素材已生成": 98,
        }
        progress = next(
            (value for prefix, value in quick_steps.items() if message.startswith(prefix)),
            progress,
        )
        match = re.search(r"逐场分析\s+(\d+)/(\d+)", message)
        if match:
            current, total = int(match.group(1)), max(1, int(match.group(2)))
            progress = 8 + int(current / total * 52)
        match = re.search(r"汇总角色\s+(\d+)/(\d+)", message)
        if match:
            current, total = int(match.group(1)), max(1, int(match.group(2)))
            progress = 62 + int(current / total * 18)
        match = re.search(r"汇总关系\s+(\d+)/(\d+)", message)
        if match:
            current, total = int(match.group(1)), max(1, int(match.group(2)))
            progress = 81 + int(current / total * 15)
        if message.startswith("报告已生成"):
            progress = 98
        self.update(job_id, message=message, progress=progress)

    def finish(self, job_id: str, result: Dict[str, Any]) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.update(
                status="complete",
                progress=100,
                message="完成",
                result=result,
                updated_at=time.time(),
            )
            job["logs"] = (job["logs"] + ["完成"])[-30:]

    def fail(self, job_id: str, error: BaseException) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.update(
                status="failed",
                message="处理失败",
                error=_safe_error(error),
                updated_at=time.time(),
            )

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return json.loads(json.dumps(job, ensure_ascii=False)) if job else None

    def active_for_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            for job in self._jobs.values():
                if job["run_id"] == run_id and job["status"] in {"queued", "running"}:
                    return dict(job)
        return None


JOBS = JobStore()
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="script-agent")


def _prepare_job(
    job_id: str, script_path: Path, run_dir: Path, previous_run_id: str = ""
) -> None:
    try:
        JOBS.update(job_id, message="正在本机读取并切分剧本", progress=15)
        max_scene_chars = 8000 if script_path.suffix.lower() == ".pdf" else 14000
        manifest = prepare_script(script_path, run_dir, max_scene_chars=max_scene_chars)
        if previous_run_id:
            previous_dir = _resolve_run(previous_run_id)
            previous_manifest_path = previous_dir / "manifest.json"
            if not previous_manifest_path.exists():
                raise ValueError("选择的上一版本不存在。")
            previous_manifest = read_json(previous_manifest_path)
            manifest["previous_run_id"] = previous_run_id
            manifest["version_number"] = int(previous_manifest.get("version_number", 1) or 1) + 1
            write_json(run_dir / "manifest.json", manifest)
        JOBS.finish(
            job_id,
            {
                "run_id": run_dir.name,
                "scene_count": manifest.get("scene_count", 0),
                "source_name": manifest.get("source_name", ""),
            },
        )
    except BaseException as exc:
        JOBS.fail(job_id, exc)


def _analysis_job(job_id: str, run_dir: Path, mode: str) -> None:
    try:
        JOBS.update(job_id, message="正在准备 AI 分析", progress=3)
        if mode == "quick":
            bundle = analyze_quick_preview(
                run_dir,
                AnalysisConfig(
                    extract_model="gpt-6-luna",
                    synthesis_model="gpt-6-luna",
                    max_output_tokens=3000,
                    max_workers=1,
                    fast_mode=True,
                ),
                progress=lambda message: JOBS.progress_message(job_id, message),
            )
        else:
            bundle = analyze_run(
                run_dir,
                AnalysisConfig(
                    extract_model="gpt-6-luna",
                    synthesis_model="gpt-6.1-sol",
                    max_output_tokens=12000,
                    max_workers=3,
                ),
                progress=lambda message: JOBS.progress_message(job_id, message),
            )
        JOBS.finish(
            job_id,
            {
                "run_id": run_dir.name,
                "character_count": len(bundle.get("characters", {})),
                "relationship_count": len(bundle.get("relationships", {})),
                "partial_analysis": bundle.get("meta", {}).get("partial_analysis", False),
            },
        )
    except BaseException as exc:
        JOBS.fail(job_id, exc)


def _character_job(job_id: str, run_dir: Path, character_name: str) -> None:
    try:
        progress_steps = {
            "正在整理": 12,
            "正在追踪": 35,
            "正在生成": 68,
            "正在更新": 92,
        }

        def update(message: str) -> None:
            progress = next(
                (value for prefix, value in progress_steps.items() if message.startswith(prefix)),
                96 if message.endswith("已生成") else None,
            )
            JOBS.update(job_id, message=message, progress=progress)

        card = analyze_character_profile(
            run_dir,
            character_name,
            AnalysisConfig(
                extract_model="gpt-6-luna",
                synthesis_model="gpt-6-luna",
                max_output_tokens=12000,
                max_workers=3,
            ),
            progress=update,
        )
        JOBS.finish(
            job_id,
            {
                "run_id": run_dir.name,
                "character_name": card.get("character_name", character_name),
                "profile_mode": card.get("_meta", {}).get("profile_mode", "full"),
            },
        )
    except BaseException as exc:
        JOBS.fail(job_id, exc)


def _tiktok_job(job_id: str, run_dir: Path, settings: Dict[str, Any]) -> None:
    try:
        result = analyze_tiktok_content(
            run_dir,
            settings,
            progress=lambda message: JOBS.progress_message(job_id, message),
        )
        JOBS.finish(
            job_id,
            {
                "run_id": run_dir.name,
                "concept_count": len(result.get("concepts", [])),
                "trend_count": len(result.get("trends", [])),
            },
        )
    except BaseException as exc:
        JOBS.fail(job_id, exc)


class ScriptAgentHandler(BaseHTTPRequestHandler):
    server_version = "ScriptAgent/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path == "/api/status":
                self._send_json(
                    {
                        "ok": True,
                        "api_key_configured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
                        "privacy": "本地运行；只有点击 AI 分析后，剧本片段才会发送到模型 API。",
                    }
                )
                return
            if path == "/api/runs":
                RUNS_ROOT.mkdir(parents=True, exist_ok=True)
                runs = []
                for run_dir in sorted(RUNS_ROOT.iterdir(), reverse=True):
                    if not run_dir.is_dir() or not (run_dir / "manifest.json").exists():
                        continue
                    try:
                        runs.append(_run_summary(run_dir))
                    except (OSError, ValueError, json.JSONDecodeError):
                        continue
                self._send_json({"runs": runs[:30]})
                return

            job_match = re.fullmatch(r"/api/jobs/([a-f0-9]{32})", path)
            if job_match:
                job = JOBS.get(job_match.group(1))
                if not job:
                    self._send_error_json(HTTPStatus.NOT_FOUND, "找不到这个任务。")
                else:
                    self._send_json(job)
                return

            report_match = re.fullmatch(r"/api/runs/([a-zA-Z0-9_-]+)/report", path)
            if report_match:
                run_dir = _resolve_run(report_match.group(1))
                report_path = run_dir / "output" / "report.json"
                if not report_path.exists():
                    self._send_error_json(HTTPStatus.NOT_FOUND, "这次运行还没有分析报告。")
                else:
                    self._send_json(read_json(report_path))
                return

            run_match = re.fullmatch(r"/api/runs/([a-zA-Z0-9_-]+)", path)
            if run_match:
                run_dir = _resolve_run(run_match.group(1))
                summary = _run_summary(run_dir)
                summary["active_job"] = JOBS.active_for_run(run_dir.name)
                scenes_path = run_dir / "source" / "scenes.json"
                scenes = read_json(scenes_path) if scenes_path.exists() else []
                summary["scenes"] = [
                    {
                        "id": item.get("id", ""),
                        "order": item.get("order", 0),
                        "heading": item.get("heading", ""),
                        "start_line": item.get("start_line", 0),
                        "end_line": item.get("end_line", 0),
                        "char_count": len(item.get("text", "")),
                    }
                    for item in scenes
                ]
                self._send_json(summary)
                return

            download_match = re.fullmatch(
                r"/api/runs/([a-zA-Z0-9_-]+)/download/([a-zA-Z0-9.\-]+)", path
            )
            if download_match:
                run_dir = _resolve_run(download_match.group(1))
                filename = download_match.group(2)
                if filename not in DOWNLOAD_FILES:
                    self._send_error_json(HTTPStatus.NOT_FOUND, "不支持下载这个文件。")
                    return
                file_path = run_dir / "output" / filename
                if not file_path.exists():
                    self._send_error_json(HTTPStatus.NOT_FOUND, "文件尚未生成。")
                    return
                self._send_bytes(
                    file_path.read_bytes(),
                    DOWNLOAD_FILES[filename],
                    extra_headers={"Content-Disposition": 'attachment; filename="{}"'.format(filename)},
                )
                return

            self._serve_static(path)
        except FileNotFoundError as exc:
            self._send_error_json(HTTPStatus.NOT_FOUND, str(exc))
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
        except BaseException as exc:
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, _safe_error(exc))

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/prepare":
                self._handle_prepare()
                return
            if parsed.path == "/api/analyze":
                self._handle_analyze()
                return
            if parsed.path == "/api/analyze-character":
                self._handle_analyze_character()
                return
            if parsed.path == "/api/generate-tiktok":
                self._handle_generate_tiktok()
                return
            self._send_error_json(HTTPStatus.NOT_FOUND, "找不到这个操作。")
        except ValueError as exc:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
        except BaseException as exc:
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, _safe_error(exc))

    def _handle_prepare(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            raise ValueError("请选择剧本文件。")
        if length > MAX_UPLOAD_BYTES:
            raise ValueError("文件超过 50MB，请先压缩或拆分。")
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "CONTENT_LENGTH": str(length),
            },
            keep_blank_values=True,
        )
        if "script" not in form:
            raise ValueError("没有收到剧本文件。")
        upload = form["script"]
        if isinstance(upload, list):
            upload = upload[0]
        filename = _safe_filename(upload.filename or "script.txt")
        suffix = Path(filename).suffix.lower()
        if suffix not in SUPPORTED_EXTENSIONS:
            raise ValueError("只支持 TXT、Markdown、Fountain、PDF 和 DOCX 剧本。")

        previous_run_id = str(form.getfirst("previous_run_id", "")).strip()
        if previous_run_id:
            previous_dir = _resolve_run(previous_run_id)
            if not (previous_dir / "manifest.json").exists():
                raise ValueError("选择的上一版本不存在。")

        run_id = _new_run_id(filename)
        run_dir = _resolve_run(run_id)
        upload_dir = run_dir / "upload"
        upload_dir.mkdir(parents=True, exist_ok=False)
        script_path = upload_dir / filename
        with script_path.open("wb") as target:
            shutil.copyfileobj(upload.file, target, length=1024 * 1024)
        job = JOBS.create("prepare", run_id, "已收到剧本，等待本地切分")
        EXECUTOR.submit(_prepare_job, job["id"], script_path, run_dir, previous_run_id)
        self._send_json(job, status=HTTPStatus.ACCEPTED)

    def _handle_analyze(self) -> None:
        payload = self._read_json_body()
        run_id = str(payload.get("run_id", ""))
        if not payload.get("permission_confirmed"):
            raise ValueError("请先确认你有权将这份剧本提交给模型分析。")
        if not os.getenv("OPENAI_API_KEY", "").strip():
            raise ValueError("本机还没有配置 API Key。")
        run_dir = _resolve_run(run_id)
        if not (run_dir / "manifest.json").exists():
            raise ValueError("请先完成本地切分。")
        active = JOBS.active_for_run(run_id)
        if active:
            self._send_json(active, status=HTTPStatus.ACCEPTED)
            return
        mode = str(payload.get("mode", "deep")).strip().lower()
        if mode not in {"quick", "deep"}:
            raise ValueError("分析模式不正确。")
        label = "一分钟快速概览" if mode == "quick" else "深度完整分析"
        job = JOBS.create("analyze", run_id, "{}已加入队列".format(label))
        EXECUTOR.submit(_analysis_job, job["id"], run_dir, mode)
        self._send_json(job, status=HTTPStatus.ACCEPTED)

    def _handle_analyze_character(self) -> None:
        payload = self._read_json_body()
        run_id = str(payload.get("run_id", ""))
        character_name = str(payload.get("character_name", "")).strip()
        if not payload.get("permission_confirmed"):
            raise ValueError("请先确认你有权将这份剧本提交给模型分析。")
        if not character_name:
            raise ValueError("请先选择要深入分析的角色。")
        if not os.getenv("OPENAI_API_KEY", "").strip():
            raise ValueError("本机还没有配置 API Key。")
        run_dir = _resolve_run(run_id)
        if not (run_dir / "output" / "report.json").exists():
            raise ValueError("请先完成快速分析。")
        active = JOBS.active_for_run(run_id)
        if active:
            self._send_json(active, status=HTTPStatus.ACCEPTED)
            return
        job = JOBS.create("character", run_id, "{} 的完整角色卡已加入队列".format(character_name))
        EXECUTOR.submit(_character_job, job["id"], run_dir, character_name)
        self._send_json(job, status=HTTPStatus.ACCEPTED)

    def _handle_generate_tiktok(self) -> None:
        payload = self._read_json_body()
        run_id = str(payload.get("run_id", ""))
        if not payload.get("permission_confirmed"):
            raise ValueError("请先确认你有权将剧本内容提交给模型和网页检索工具。")
        if not os.getenv("OPENAI_API_KEY", "").strip():
            raise ValueError("本机还没有配置 API Key。")
        run_dir = _resolve_run(run_id)
        if not (run_dir / "output" / "report.json").exists():
            raise ValueError("请先完成至少一次剧本概览。")
        active = JOBS.active_for_run(run_id)
        if active:
            self._send_json(active, status=HTTPStatus.ACCEPTED)
            return
        settings = payload.get("settings")
        if not isinstance(settings, dict):
            raise ValueError("短视频素材设置不正确。")
        job = JOBS.create("tiktok", run_id, "TikTok 热点素材生成已加入队列")
        EXECUTOR.submit(_tiktok_job, job["id"], run_dir, settings)
        self._send_json(job, status=HTTPStatus.ACCEPTED)

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 1024 * 1024:
            raise ValueError("请求内容不正确。")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求内容不是有效 JSON。") from exc

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path in {"", "/"} else path.lstrip("/")
        if relative not in {"index.html", "styles.css", "app.js"}:
            self._send_error_json(HTTPStatus.NOT_FOUND, "页面不存在。")
            return
        file_path = STATIC_ROOT / relative
        if not file_path.exists():
            self._send_error_json(HTTPStatus.NOT_FOUND, "网页资源尚未生成。")
            return
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type == "application/javascript":
            content_type += "; charset=utf-8"
        self._send_bytes(file_path.read_bytes(), content_type)

    def _send_json(self, value: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._send_bytes(payload, "application/json; charset=utf-8", status=status)

    def _send_error_json(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"error": message}, status=status)

    def _send_bytes(
        self,
        payload: bytes,
        content_type: str,
        *,
        status: HTTPStatus = HTTPStatus.OK,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> None:
        self.send_response(int(status))
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        )
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        return


def serve(host: str = "127.0.0.1", port: int = 8000) -> None:
    _load_local_env()
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("为了保护剧本与 API Key，网页默认只允许本机访问。")
    server = ThreadingHTTPServer((host, port), ScriptAgentHandler)
    print("角色档案 Agent 已启动：http://{}:{}/".format(host, port), flush=True)
    print("按 Control+C 可以停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        EXECUTOR.shutdown(wait=False)


def main(argv: Optional[list] = None) -> None:
    parser = argparse.ArgumentParser(description="启动长剧本角色卡与关系 Agent 网页")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    args = parser.parse_args(argv)
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
