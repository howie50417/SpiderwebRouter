# SpiderwebRouter

SpiderwebRouter 是可自行架設的大模型中轉站。它把 OpenAI、Gemini、OpenAI-compatible（例如 vLLM 與 Unsloth Studio）、Ollama 與 Open WebUI 的模型，透過單一 OpenAI 相容 `/v1` API 提供給獲授權的客戶。系統包含繁體中文／英文管理後台、模型掃描與發布、用戶別名與定價、API key、Playground、API 文件、使用量統計、retry 診斷及完整 audit log。

本專案不保存 prompt、completion、tool payload 或圖片內容。對客戶的錯誤皆由 SpiderwebRouter 重新封裝；上游的詳細錯誤只會寫入已去敏的容器日誌。

## 架構

| Compose service | 用途                                                    | 對宿主機發布 port |
| --------------- | ------------------------------------------------------- | ----------------- |
| `edge`          | Caddy、前端靜態檔、SPA fallback、API／SSE reverse proxy | `80`              |
| `api`           | NestJS/Fastify 控制平面與 OpenAI-compatible gateway     | 無                |
| `worker`        | 模型掃描、健康檢查、背景工作與 usage rollup             | 無                |
| `migrate`       | 一次性執行 Prisma migrations                            | 無                |
| `bootstrap`     | 冪等建立初始超管及同步 Keycloak 設定                    | 無                |
| `postgres`      | 應用程式與 Keycloak 各自獨立的 PostgreSQL database      | 無                |
| `redis`         | BullMQ 與伺服器端 session                               | 無                |
| `keycloak`      | OIDC、角色與登入流程                                    | 無                |

只有 `edge` 對外發布 TCP port 80。資料庫與 Redis 位於 internal Docker network；API/worker 另有 outbound network，才能呼叫經允許的第三方模型服務。持久資料保存在 named volumes。

## 部署

### 需求

- Docker Engine 或 Docker Desktop，並支援 `docker compose` v2。
- 宿主機 TCP port 80 尚未被占用。
- 一個已在外層 TLS reverse proxy／load balancer 終止 HTTPS 的網域。外層代理必須保留 `Host`，並正確送出 `X-Forwarded-For` 與 `X-Forwarded-Proto: https`。
- Linux/macOS 使用 Bash；Windows 可直接使用 PowerShell 5.1 以上。

不需要在宿主機安裝 Node.js、pnpm、PostgreSQL、Redis、Caddy 或 Keycloak。

### 1. 建立 `.env` 與 secrets

Linux/macOS：

```bash
bash scripts/init-env.sh
```

Windows PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init-env.ps1
```

腳本會先確認 Docker daemon、Compose v2 與 port 80，再詢問：

- 對外 HTTPS origin，例如 `https://ai.example.com`（不可包含 path）；
- 前方 TLS proxy 的 CIDR。單機私有網路可接受預設 `private_ranges`，公網部署應填入實際且最小的 CIDR 清單；
- 初始超級管理員 email；
- 初始暫時密碼，輸入時不會顯示。

腳本從 `.env.example` 建立 `.env`，並以作業系統的 CSPRNG 在 `secrets/` 產生 PostgreSQL、Redis、Keycloak、session、API key pepper 與 Provider 加密金鑰。Bash 會將 `.env` 設為 mode `600`、`secrets/` 目錄設為 `700`，並將目錄內的 secret files 設為 `644`。這是因為本機 Docker Compose 對 file-based secrets 使用 bind mount，檔案必須讓不同的非 root 容器 UID 讀取；宿主機上的其他帳號仍無法穿越 mode `700` 的父目錄。PowerShell 會收緊 NTFS ACL，並保留 Docker Desktop 所需的 SYSTEM 存取。secret 不會顯示在終端，也不會寫入 `.env`。

若 `.env` 已存在，腳本只驗證設定與所有 secret files，並修正上述檔案權限；絕不覆寫或重新產生任何 secret 內容。若要重建環境，請先自行安全備份並移走既有 `.env` 與 `secrets/`；不要只刪除其中一邊。

### 2. 啟動完整系統

```bash
docker compose up -d
docker compose ps
```

第一次啟動會建置前後端 image、初始化兩個 PostgreSQL database、匯入 Keycloak realm、執行 migration，再建立初始超管。`migrate` 與 `bootstrap` 最後顯示 `Exited (0)` 是正常狀態；`edge`、`api`、`worker`、`postgres`、`redis`、`keycloak` 應為 running/healthy。

#### 舊版 secret 權限造成首次啟動中斷

如果日誌出現 `Required secret file ... is not readable` 或 `KEYCLOAK_DB_PASSWORD_FILE is not readable`，代表舊版初始化腳本把 Linux secret files 設成了 mode `600`。PostgreSQL 此時可能已建立資料叢集，但尚未建立 `app` schema 與 Keycloak database，因此只修權限後直接重跑 `up` 仍不完整。使用以下非破壞性流程修復；初始化 SQL 是冪等的，不需要刪除 volume：

```bash
sudo chmod 0700 secrets
sudo find secrets -maxdepth 1 -type f -exec chmod 0644 {} +
docker compose stop keycloak
docker compose up -d postgres
docker compose exec --user postgres postgres /docker-entrypoint-initdb.d/10-init-databases.sh
docker compose up -d --build
docker compose ps -a
```

若仍未 healthy，取得聚焦日誌：

```bash
docker compose logs --tail=200 postgres migrate keycloak bootstrap api worker edge
```

不要為了這個權限問題執行 `docker compose down -v`；那會刪除所有服務的持久 volume。

外層 HTTPS proxy 的 upstream 指向 `http://<SpiderwebRouter-host>:80`。請勿另外發布 Compose 內部服務的 ports，也不要將 port 80 直接暴露至不受信任的 Internet；公開入口應為 HTTPS。

開啟 `.env` 中的 `PUBLIC_BASE_URL` 登入。初始密碼只用於第一次登入，Keycloak 會要求立即更換。TOTP 預設**不啟用且不強制**；使用者之後仍可自行啟用 TOTP。

### 3. 建立 Provider 與授權模型

1. 以超管進入「Provider」，選擇 OpenAI、Gemini、Generic OpenAI-compatible、Ollama 或 Open WebUI。
2. 填入 base URL、認證模式（無認證或 Bearer token）與 timeout，然後測試連線。
3. 執行「掃描模型」。掃描只取得清單與 metadata，不會自動發出可能計費的推理請求。
4. 從候選模型選擇要發布的項目，設定公開 alias、能力、system prompt、thinking、input/output USD 單價及 `maxRetries`。
5. 對個別用戶授權模型，必要時覆寫 alias 或客製價格。新用戶預設可用模型數為零。

`maxRetries` 是初次請求以外的重試次數，範圍 `0–5`；設定 `2` 代表最多三次 attempts。只會在尚未對客戶輸出任何 byte 時，對同一 Provider／同一上游模型的 timeout、連線錯誤、408、429、500、502、503、504 進行重試，不會暗中切換來源。

## 客戶 API

在登入後的「API Keys」建立 key。完整的 `sk-swr-...` 只顯示一次；伺服器只保存不可逆驗證值、prefix 與末四碼。所有 `/v1/*` 請求都使用：

```http
Authorization: Bearer sk-swr-your-key
```

公開端點：

| Endpoint                                   | 說明                                           |
| ------------------------------------------ | ---------------------------------------------- |
| `GET /v1/models`、`GET /v1/models/{alias}` | 只列出該用戶獲授權的 alias                     |
| `POST /v1/chat/completions`                | OpenAI Chat Completions，同步或 SSE            |
| `POST /v1/responses`                       | OpenAI Responses，包含 typed SSE 與 tool items |
| `POST /v1/embeddings`                      | 單筆或批次 embeddings                          |

Chat Completions 範例：

```bash
curl https://ai.example.com/v1/chat/completions \
  -H 'Authorization: Bearer sk-swr-your-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-chat-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Responses 範例：

```bash
curl https://ai.example.com/v1/responses \
  -H 'Authorization: Bearer sk-swr-your-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-agent-model",
    "input": "Summarize the retry behavior in one sentence."
  }'
```

登入後可在 `/playground` 試玩文字、圖片與 tools，並在 `/docs` 檢視完整 OpenAPI 文件與 Scalar Try It。Playground 和 Try It 都經過同一套授權、prompt 注入、retry、usage 與計價流程，不是免費旁路。

### OpenAI JavaScript SDK

```bash
npm install openai
```

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.SPIDERWEBROUTER_API_KEY,
  baseURL: 'https://ai.example.com/v1',
});

const response = await client.responses.create({
  model: 'my-agent-model',
  input: 'Hello from SpiderwebRouter',
});
console.log(response.output_text);
```

### OpenAI Python SDK

```bash
pip install openai
```

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["SPIDERWEBROUTER_API_KEY"],
    base_url="https://ai.example.com/v1",
)

response = client.responses.create(
    model="my-agent-model",
    input="Hello from SpiderwebRouter",
)
print(response.output_text)
```

### Codex CLI

先將 key 放在環境變數，勿寫進 `config.toml`：

```bash
export SPIDERWEBROUTER_API_KEY='sk-swr-your-key'
```

PowerShell：

```powershell
$env:SPIDERWEBROUTER_API_KEY = 'sk-swr-your-key'
```

在 Codex 的 `config.toml` 新增：

```toml
model = "my-agent-model"
model_provider = "spiderwebrouter"

[model_providers.spiderwebrouter]
name = "SpiderwebRouter"
base_url = "https://ai.example.com/v1"
env_key = "SPIDERWEBROUTER_API_KEY"
wire_api = "responses"
```

模型 alias 必須是該用戶已獲授權的名稱；原始 Provider 與上游模型 ID 不會出現在客戶回應中。

## 錯誤與日誌排查

所有 `/v1` 錯誤使用穩定且安全的 OpenAI-compatible envelope：

```json
{
  "error": {
    "message": "The model service is temporarily unavailable.",
    "type": "server_error",
    "param": null,
    "code": "provider_unavailable",
    "request_id": "req_example"
  }
}
```

客戶不會收到第三方 error body/header、Provider 名稱、原始模型 ID、URL、stack trace、SDK error object 或上游 request ID。請從 `x-request-id` response header 或 error body 取得本系統的 `request_id`。

即時查看 API 與 worker JSON logs：

```bash
docker compose logs -f api worker
```

依 request ID 搜尋（Linux/macOS）：

```bash
docker compose logs --since=2h api worker | grep '"request_id":"req_example"'
```

PowerShell：

```powershell
docker compose logs --since=2h api worker | Select-String '"request_id":"req_example"'
```

每個 Provider attempt 會記錄 attempt number、Provider 與上游模型、目的 host/path、HTTP status、latency、timeout、重試判定、去敏且最多 16 KiB 的 error body，以及必要的 stack trace。Authorization、完整 key/secret、cookie、prompt、回覆、圖片、tool arguments 與完整 request body 永不記錄。容器的 JSON logs 會自動輪替（每檔 10 MiB，保留 5 檔）。日誌仍屬敏感營運資料，請限制 Docker daemon 與主機日誌的存取權限。

常用診斷：

```bash
# 服務與 health 狀態
docker compose ps

# 一次性 migration/bootstrap 結果
docker compose logs migrate bootstrap

# Keycloak 或資料層啟動問題
docker compose logs keycloak postgres redis

# 驗證最終 Compose 設定（會隱藏 secret 檔案內容，但仍勿公開貼出）
docker compose config
```

## 計量與價格

- 價格單位固定為 USD／每 1,000,000 tokens，input 與 output 分開設定。
- 用戶客製價格為 `null` 時繼承全局，`0` 表示免費；歷史請求保存當時的價格快照。
- cached input 按 input 價格，reasoning tokens 按 output 價格，平台注入的 system prompt 也計入 input。
- 上游未提供 usage 時，系統使用 tokenizer 或保守估算並標記 `estimated`。
- retry 中未交付給客戶的失敗 attempts 不計費；串流已輸出的部分則依實際可得或估算 usage 記錄。

第一版只提供 usage 與 USD 金額統計，不包含儲值、扣款、發票、帳單、RPM、TPM 或併發限制。

## 維運

停止服務但保留資料：

```bash
docker compose down
```

更新並重新建置：

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
```

備份兩個 PostgreSQL database：

```bash
docker compose exec -T postgres pg_dump -U spiderwebrouter -d spiderwebrouter > spiderwebrouter.sql
docker compose exec -T postgres pg_dump -U spiderwebrouter -d keycloak > keycloak.sql
```

同時備份 `.env`、整個 `secrets/` 及 SQL dumps，並使用加密且受存取控制的備份位置。遺失 `provider_encryption_key` 將無法解密既有 Provider token；變更 `api_key_pepper` 會使既有客戶 API keys 全部失效。

不要執行 `docker compose down -v`，除非確定要永久刪除 PostgreSQL、Redis、Keycloak 與 Caddy named volumes。

## 安全注意事項

- 使用者先前曾貼出的 Open WebUI key 已視為洩漏，工作區中的 `ai.txt` 已刪除。部署前仍必須在 Open WebUI 來源端**撤銷並輪替**，並清查 shell history、聊天紀錄、ticket、log 或備份；本專案不會使用或 seed 該 key。
- 不要把 `.env`、`secrets/`、客戶 API key、Provider token、SQL dump 或完整容器日誌提交到 Git。
- Provider base URL 原則上必須為 HTTPS。明確列在 `ALLOWED_HTTP_PROVIDER_HOSTS` 的 Compose DNS hostname 才能使用 HTTP；localhost、link-local、cloud metadata IP 與跨 host redirect 仍會被阻擋。
- 只信任真正的 TLS proxy CIDR。過寬的 `TRUSTED_PROXY_CIDRS` 可能讓攻擊者偽造 client IP 或 scheme。
- Keycloak 禁止公開註冊。新建用戶預設零模型權限；管理員必須逐一授權。
- Provider secret 採 AES-256-GCM 加密且只能替換、不能讀回。所有角色、定價、模型授權、Provider 與 secret 變更都會寫入去敏 audit log。
- 初始超管預設不要求 TOTP 是產品設定，不代表建議長期停用；正式環境可在首次登入後自行啟用。

相關文件：[Docker Compose](https://docs.docker.com/compose/)、[Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Keycloak container](https://www.keycloak.org/server/containers)、[OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Codex custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)。
