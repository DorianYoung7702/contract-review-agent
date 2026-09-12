# DingTalk Worker（薄网关）

群聊/单聊收合同文件 → 调用本系统 Intake API → 审查完成后由后端钉钉通知「等待确认」→ 用户回复 `确认 #id` / `驳回 #id`。

```bash
cp .env.example .env
# 填写 DINGTALK_* 与 DINGTALK_INTAKE_TOKEN（与 backend/.env 一致）
pip install -r requirements.txt
python main.py
```

或：

```bash
docker compose --profile dingtalk up -d dingtalk-worker
```
