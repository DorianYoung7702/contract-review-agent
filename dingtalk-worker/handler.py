"""Process DingTalk chat → backend intake / confirm."""

from __future__ import annotations

import logging
import re
import time

from client import BackendClient, DingTalkClient
from models import ChatMessagePayload

logger = logging.getLogger(__name__)

SUPPORTED = (".docx", ".pdf")
WELCOME = (
    "【合同审查机器人】用法（钉钉无法同一条消息又@又发文件）\n"
    "\n"
    "【推荐】点开我的头像 → 进单聊 → 直接发 docx/pdf\n"
    "\n"
    "【群聊两步】\n"
    "1) 先 @我 发：审查\n"
    "2) 再单独发合同文件（这一条不用再 @）\n"
    "\n"
    "审查完成后回复：\n"
    "确认 #合同ID\n"
    "或 驳回 #合同ID 原因"
)

CONFIRM_RE = re.compile(r"^\s*确认\s*#?\s*(\d+)\s*$", re.I)
REJECT_RE = re.compile(r"^\s*驳回\s*#?\s*(\d+)\s*(.*)$", re.I)
ARM_RE = re.compile(r"^(审查|送审|开始审查|合同审查|上传合同)$", re.I)

# conversation_id -> expire_ts：@「审查」后短时内收下一份群文件
_ARMED: dict[str, float] = {}
_ARM_TTL_SEC = 10 * 60


def _arm_key(payload: ChatMessagePayload) -> str:
    return f"{payload.conversation_id}:{payload.sender_staff_id}"


def _arm_session(payload: ChatMessagePayload) -> None:
    _ARMED[_arm_key(payload)] = time.time() + _ARM_TTL_SEC


def _is_armed(payload: ChatMessagePayload) -> bool:
    key = _arm_key(payload)
    exp = _ARMED.get(key)
    if not exp:
        return False
    if time.time() > exp:
        _ARMED.pop(key, None)
        return False
    return True


def _clear_arm(payload: ChatMessagePayload) -> None:
    _ARMED.pop(_arm_key(payload), None)


async def process_message(payload: ChatMessagePayload) -> str:
    # 群聊文本必须 @；文件：单聊直接收，群聊需已 @「审查」武装或消息本身带 at
    if payload.conversation_type != "1" and payload.msgtype == "text" and not payload.is_in_at_list:
        return ""

    if payload.msgtype == "text":
        return await _handle_text(payload)
    if payload.msgtype == "file":
        return await _handle_file(payload)
    return "暂不支持该消息类型。请发送 docx/pdf 合同文件，或回复「帮助」。"


async def _handle_text(payload: ChatMessagePayload) -> str:
    text = (payload.text_content or "").strip()
    text = re.sub(r"^@\S+\s*", "", text).strip()
    if not text or text in {"帮助", "help", "?", "？"}:
        return WELCOME

    m = CONFIRM_RE.match(text)
    if m:
        api = BackendClient()
        cid = int(m.group(1))
        result = await api.confirm(
            contract_id=cid,
            action="confirm",
            staff_id=payload.sender_staff_id,
        )
        return (
            f"已确认合同 #{cid}。\n"
            f"状态：{result.get('confirmation_status')}；AI 决策：{result.get('decision')}"
        )

    m = REJECT_RE.match(text)
    if m:
        api = BackendClient()
        reason = (m.group(2) or "").strip()
        result = await api.confirm(
            contract_id=int(m.group(1)),
            action="reject",
            staff_id=payload.sender_staff_id,
            reason=reason,
        )
        return (
            f"已驳回确认合同 #{m.group(1)}。\n"
            f"状态：{result.get('confirmation_status')}"
        )

    if ARM_RE.match(text) or "审查" in text or "合同" in text:
        _arm_session(payload)
        return (
            "已准备接收合同。\n"
            "请接下来【单独发送】docx/pdf 文件（这一条不用再 @）。\n"
            "若发了文件我没反应：请点我头像进【单聊】直接发文件（最稳）。"
        )

    _arm_session(payload)
    return (
        "已收到说明。请接下来【单独发送】合同文件（docx/pdf，不必再 @）。\n"
        "也可点我头像进单聊直接发文件。"
    )


async def _handle_file(payload: ChatMessagePayload) -> str:
    is_private = payload.conversation_type == "1"
    # 群聊里钉钉常不把「未 @ 的文件」推给机器人；若推到了则受理
    if not is_private and not payload.is_in_at_list and not _is_armed(payload):
        logger.info(
            "group file ignored (not armed): conv=%s file=%s",
            payload.conversation_id,
            payload.file_name,
        )
        return (
            "群里发文件前，请先 @我 发送「审查」，再单独发文件。\n"
            "或点我头像进单聊直接发文件。"
        )

    filename = payload.file_name or "contract.docx"
    if not filename.lower().endswith(SUPPORTED):
        return f"不支持的文件类型：{filename}。请发送 docx 或 pdf。"

    dt = DingTalkClient()
    if not payload.download_code:
        return (
            "未获取到文件下载码。\n"
            "请点我头像进【单聊】重新发送该文件；群聊请先 @我 发「审查」再发文件。"
        )
    file_bytes = await dt.download_robot_file(payload.download_code)

    api = BackendClient()
    result = await api.intake_file(
        file_bytes=file_bytes,
        filename=filename,
        staff_id=payload.sender_staff_id,
        staff_nick=payload.sender_nick,
        conversation_id=payload.conversation_id,
        msg_id=payload.msg_id or f"{payload.conversation_id}:{filename}:{payload.sender_staff_id}",
        session_webhook=payload.session_webhook,
    )
    _clear_arm(payload)
    cid = result.get("contractId")
    if result.get("duplicate"):
        return f"该消息已受理过。合同 #{cid}，当前状态：{result.get('status')}"
    return (
        f"合同已受理，自动审查已启动。\n"
        f"合同ID：#{cid}\n"
        f"文件：{filename}\n"
        f"完成后将通知您确认。"
    )


async def handle_and_reply(payload: ChatMessagePayload) -> str:
    reply = await process_message(payload)
    if reply and payload.session_webhook:
        await DingTalkClient().reply_session_webhook(payload.session_webhook, reply)
    return reply
