from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, Optional


class ModelCallError(RuntimeError):
    pass


class StructuredModelClient:
    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, retries: int = 2):
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise ModelCallError(
                "尚未安装 OpenAI Python 包。请先运行：python3 -m pip install -r requirements.txt"
            ) from exc

        resolved_key = api_key or os.getenv("OPENAI_API_KEY")
        if not resolved_key:
            raise ModelCallError(
                "没有找到 OPENAI_API_KEY。请确认公司允许上传剧本后，再在本机环境变量中设置密钥。"
            )
        kwargs = {"api_key": resolved_key}
        try:
            timeout_seconds = float(os.getenv("OPENAI_TIMEOUT_SECONDS", "180"))
        except ValueError:
            timeout_seconds = 180.0
        kwargs["timeout"] = max(30.0, timeout_seconds)
        # This class owns the retry loop so a single request cannot silently
        # multiply SDK retries and appear frozen for a very long time.
        kwargs["max_retries"] = 0
        resolved_base_url = base_url or os.getenv("OPENAI_BASE_URL")
        if resolved_base_url:
            kwargs["base_url"] = resolved_base_url
        self.client = OpenAI(**kwargs)
        self.retries = max(1, retries)

    def generate(
        self,
        *,
        model: str,
        instructions: str,
        input_text: str,
        schema_name: str,
        schema: Dict[str, Any],
        max_output_tokens: int = 24000,
    ) -> Dict[str, Any]:
        last_error = None
        output_budget = max(1000, int(max_output_tokens))
        for attempt in range(1, self.retries + 1):
            try:
                response = self.client.responses.create(
                    model=model,
                    instructions=instructions,
                    input=input_text,
                    text={
                        "format": {
                            "type": "json_schema",
                            "name": schema_name,
                            "strict": True,
                            "schema": schema,
                        }
                    },
                    max_output_tokens=output_budget,
                    store=False,
                )
                if getattr(response, "status", None) == "incomplete":
                    details = getattr(response, "incomplete_details", None)
                    reason = getattr(details, "reason", "")
                    if (
                        reason == "max_output_tokens"
                        and attempt < self.retries
                        and output_budget < 24000
                    ):
                        output_budget = min(
                            24000,
                            max(output_budget + 2000, int(output_budget * 1.5)),
                        )
                        last_error = ModelCallError("模型输出超过上限，正在扩大输出空间后重试。")
                        continue
                    raise ModelCallError("模型输出不完整：{}".format(details))
                output_text = getattr(response, "output_text", "")
                if not output_text:
                    raise ModelCallError("模型没有返回可解析的结构化文本。")
                return json.loads(output_text)
            except Exception as exc:  # SDK exceptions vary by version.
                last_error = exc
                if attempt >= self.retries:
                    break
                time.sleep(min(2 ** (attempt - 1), 8))
        raise ModelCallError("模型调用失败：{}".format(last_error)) from last_error

    def generate_with_web_search(
        self,
        *,
        model: str,
        instructions: str,
        input_text: str,
        schema_name: str,
        schema: Dict[str, Any],
        max_output_tokens: int = 16000,
        country: str = "US",
        timezone: str = "America/New_York",
    ) -> Dict[str, Any]:
        """Generate strict JSON after a required live web search.

        The returned `_web_sources` list comes from the hosted tool response,
        not from model-authored URLs, so the UI can show grounded links.
        """
        last_error = None
        output_budget = max(2000, int(max_output_tokens))
        for attempt in range(1, self.retries + 1):
            try:
                response = self.client.responses.create(
                    model=model,
                    instructions=instructions,
                    input=input_text,
                    tools=[
                        {
                            "type": "web_search",
                            "search_context_size": "medium",
                            "user_location": {
                                "type": "approximate",
                                "country": country,
                                "timezone": timezone,
                            },
                        }
                    ],
                    tool_choice="required",
                    include=["web_search_call.action.sources"],
                    text={
                        "format": {
                            "type": "json_schema",
                            "name": schema_name,
                            "strict": True,
                            "schema": schema,
                        }
                    },
                    reasoning={"effort": "low"},
                    max_output_tokens=output_budget,
                    store=False,
                )
                if getattr(response, "status", None) == "incomplete":
                    details = getattr(response, "incomplete_details", None)
                    reason = getattr(details, "reason", "")
                    if reason == "max_output_tokens" and attempt < self.retries:
                        output_budget = min(24000, max(output_budget + 3000, int(output_budget * 1.5)))
                        last_error = ModelCallError("热点素材输出超过上限，正在扩大输出空间后重试。")
                        continue
                    raise ModelCallError("热点素材输出不完整：{}".format(details))
                output_text = getattr(response, "output_text", "")
                if not output_text:
                    raise ModelCallError("模型没有返回可解析的热点素材。")
                result = json.loads(output_text)
                result["_web_sources"] = self._web_sources(response)
                return result
            except Exception as exc:
                last_error = exc
                if attempt >= self.retries:
                    break
                time.sleep(min(2 ** (attempt - 1), 8))
        raise ModelCallError("热点检索与素材生成失败：{}".format(last_error)) from last_error

    @staticmethod
    def _web_sources(response: Any) -> list:
        if hasattr(response, "model_dump"):
            payload = response.model_dump()
        elif hasattr(response, "to_dict"):
            payload = response.to_dict()
        else:
            payload = {}
        output = []
        seen = set()
        for item in payload.get("output", []) or []:
            if item.get("type") != "web_search_call":
                continue
            action = item.get("action") or {}
            for source in action.get("sources", []) or []:
                url = str(source.get("url", "")).strip()
                if not url or url in seen:
                    continue
                seen.add(url)
                output.append(
                    {
                        "url": url,
                        "title": str(source.get("title", "")).strip(),
                        "type": str(source.get("type", "")).strip(),
                    }
                )
        return output
