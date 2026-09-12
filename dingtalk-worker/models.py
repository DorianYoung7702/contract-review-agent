"""Normalize DingTalk Stream chat payloads."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class ChatMessagePayload:
    msgtype: Literal["text", "file", "picture", "richText", "audio", "video"]
    sender_staff_id: str
    sender_nick: str
    conversation_id: str
    conversation_type: str = "1"
    session_webhook: str = ""
    text_content: str = ""
    file_name: str = ""
    download_code: str = ""
    msg_id: str = ""
    is_in_at_list: bool = True
    raw: dict[str, Any] = field(default_factory=dict)


def normalize_chat_payload(data: dict[str, Any]) -> ChatMessagePayload:
    msgtype = str(data.get("msgtype") or data.get("msgType") or "text")
    sender_staff_id = str(
        data.get("senderStaffId")
        or data.get("sender_staff_id")
        or data.get("senderId")
        or "unknown"
    )
    sender_nick = str(data.get("senderNick") or data.get("sender_nick") or "未知用户")
    conversation_id = str(
        data.get("conversationId") or data.get("conversation_id") or sender_staff_id
    )
    conversation_type = str(data.get("conversationType") or data.get("conversation_type") or "1")
    session_webhook = str(data.get("sessionWebhook") or data.get("session_webhook") or "")
    is_in_at_list = bool(data.get("isInAtList", data.get("is_in_at_list", True)))
    msg_id = str(data.get("msgId") or data.get("msg_id") or data.get("messageId") or "")

    text_content = ""
    file_name = ""
    download_code = ""

    if msgtype == "text":
        text_obj = data.get("text") or {}
        text_content = str(text_obj.get("content") or data.get("text_content") or "")
    elif msgtype == "file":
        content = data.get("content") or data.get("file") or {}
        if not isinstance(content, dict):
            content = {}
        file_name = str(
            content.get("fileName")
            or content.get("file_name")
            or data.get("fileName")
            or "contract.docx"
        )
        download_code = str(
            content.get("downloadCode")
            or content.get("download_code")
            or data.get("downloadCode")
            or ""
        )
    elif msgtype == "richText":
        rich = (data.get("content") or {}).get("richText") or data.get("richText") or []
        parts: list[str] = []
        if isinstance(rich, list):
            for item in rich:
                if isinstance(item, dict) and item.get("text"):
                    parts.append(str(item["text"]))
        text_content = "\n".join(parts).strip()
        msgtype = "text"

    return ChatMessagePayload(
        msgtype=msgtype,  # type: ignore[arg-type]
        sender_staff_id=sender_staff_id,
        sender_nick=sender_nick,
        conversation_id=conversation_id,
        conversation_type=conversation_type,
        session_webhook=session_webhook,
        text_content=text_content,
        file_name=file_name,
        download_code=download_code,
        msg_id=msg_id,
        is_in_at_list=is_in_at_list,
        raw=data,
    )
