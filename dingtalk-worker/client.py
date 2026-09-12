"""DingTalk API helpers + backend intake client."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_TOKEN_CACHE: dict[str, Any] = {"token": "", "expires_at": 0.0}


def _backend_base_url() -> str:
    return (
        os.getenv("BACKEND_BASE_URL")
        or os.getenv("XIAODINGFENG_BASE_URL")  # legacy alias
        or "http://localhost:3001"
    ).rstrip("/")


class BackendClient:
    def __init__(self) -> None:
        self.base = _backend_base_url()
        self.token = os.getenv("DINGTALK_INTAKE_TOKEN") or ""

    def _headers(self) -> dict[str, str]:
        return {"X-Internal-Token": self.token}

    async def intake_file(
        self,
        *,
        file_bytes: bytes,
        filename: str,
        staff_id: str,
        staff_nick: str,
        conversation_id: str,
        msg_id: str,
        session_webhook: str,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.base}/api/integrations/dingtalk/intake",
                headers=self._headers(),
                data={
                    "staff_id": staff_id,
                    "staff_nick": staff_nick,
                    "conversation_id": conversation_id,
                    "msg_id": msg_id,
                    "session_webhook": session_webhook,
                },
                files={"file": (filename, file_bytes, "application/octet-stream")},
            )
            resp.raise_for_status()
            return resp.json()

    async def confirm(
        self,
        *,
        contract_id: int,
        action: str,
        staff_id: str,
        reason: str = "",
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self.base}/api/integrations/dingtalk/confirm",
                headers=self._headers(),
                json={
                    "contract_id": contract_id,
                    "action": action,
                    "staff_id": staff_id,
                    "reason": reason,
                },
            )
            resp.raise_for_status()
            return resp.json()


class DingTalkClient:
    async def get_access_token(self) -> str:
        now = time.time()
        if _TOKEN_CACHE["token"] and _TOKEN_CACHE["expires_at"] > now + 60:
            return _TOKEN_CACHE["token"]
        app_key = os.getenv("DINGTALK_APP_KEY") or ""
        app_secret = os.getenv("DINGTALK_APP_SECRET") or ""
        if not app_key or not app_secret:
            raise ValueError("DINGTALK_APP_KEY and DINGTALK_APP_SECRET are required")
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://api.dingtalk.com/v1.0/oauth2/accessToken",
                json={"appKey": app_key, "appSecret": app_secret},
            )
            resp.raise_for_status()
            data = resp.json()
        _TOKEN_CACHE["token"] = data["accessToken"]
        _TOKEN_CACHE["expires_at"] = now + int(data.get("expireIn", 7200))
        return _TOKEN_CACHE["token"]

    async def download_robot_file(self, download_code: str) -> bytes:
        robot_code = os.getenv("DINGTALK_ROBOT_CODE") or ""
        if not robot_code:
            raise ValueError("DINGTALK_ROBOT_CODE is required")
        token = await self.get_access_token()
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
                headers={"x-acs-dingtalk-access-token": token},
                json={"downloadCode": download_code, "robotCode": robot_code},
            )
            resp.raise_for_status()
            download_url = resp.json()["downloadUrl"]
            file_resp = await client.get(download_url)
            file_resp.raise_for_status()
            return file_resp.content

    async def reply_session_webhook(self, session_webhook: str, content: str) -> None:
        if not session_webhook:
            logger.info("skip webhook reply: %s", content[:160])
            return
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                session_webhook,
                json={"msgtype": "text", "text": {"content": content}},
            )
            resp.raise_for_status()
