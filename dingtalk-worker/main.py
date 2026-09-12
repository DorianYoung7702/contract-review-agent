"""DingTalk Stream worker entrypoint."""

from __future__ import annotations

import asyncio
import logging
import os
import sys

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("dingtalk-worker")


def run_stream() -> None:
    try:
        import dingtalk_stream
        from dingtalk_stream import AckMessage
    except ImportError as exc:
        raise RuntimeError("pip install dingtalk-stream") from exc

    from handler import handle_and_reply
    from models import normalize_chat_payload

    app_key = os.getenv("DINGTALK_APP_KEY") or ""
    app_secret = os.getenv("DINGTALK_APP_SECRET") or ""
    if not app_key or not app_secret:
        raise ValueError("DINGTALK_APP_KEY and DINGTALK_APP_SECRET are required")

    class Handler(dingtalk_stream.ChatbotHandler):
        async def process(self, callback: dingtalk_stream.CallbackMessage):
            payload = normalize_chat_payload(callback.data)
            try:
                reply = await handle_and_reply(payload)
                if reply and not payload.session_webhook:
                    incoming = dingtalk_stream.ChatbotMessage.from_dict(callback.data)
                    self.reply_text(reply, incoming)
            except Exception:
                logger.exception("Failed to process chat message")
                incoming = dingtalk_stream.ChatbotMessage.from_dict(callback.data)
                self.reply_text("处理失败，请稍后重试。", incoming)
            return AckMessage.STATUS_OK, "OK"

    credential = dingtalk_stream.Credential(app_key, app_secret)
    client = dingtalk_stream.DingTalkStreamClient(credential)
    client.register_callback_handler(
        dingtalk_stream.chatbot.ChatbotMessage.TOPIC,
        Handler(),
    )
    logger.info(
        "DingTalk Stream started robot=%s backend=%s",
        os.getenv("DINGTALK_ROBOT_CODE"),
        os.getenv("BACKEND_BASE_URL") or os.getenv("XIAODINGFENG_BASE_URL"),
    )
    client.start_forever()


async def idle() -> None:
    logger.info("DINGTALK_WORKER_MOCK=true — idle. Configure keys and set MOCK=false for Stream.")
    while True:
        await asyncio.sleep(60)


if __name__ == "__main__":
    if (os.getenv("DINGTALK_WORKER_MOCK") or "").lower() in {"1", "true", "yes"}:
        asyncio.run(idle())
    else:
        try:
            run_stream()
        except Exception as exc:
            logger.error("%s", exc)
            sys.exit(1)
