# Outlook Pool 📮

批量 Outlook 邮箱池管理工具 — 基于 Microsoft Graph API + OAuth2 refresh_token。

## 功能

- **批量导入**：粘贴 `邮箱----密码----client_id----refresh_token`，每行一个，同邮箱自动覆盖
- **账号状态面板**：✅正常 / ⚠️错误 / ❌失效 / ❓未检查，一目了然
- **在线看邮件**：点账号看收件箱，点邮件看正文（HTML 渲染）
- **验证码自动识别**：邮件列表自动提取验证码，点击即复制
- **自动巡检**：每天自动刷新全部账号 token，死号自动标记
- **refresh_token 自动轮换**：微软每次发新 token 自动存库，不会变一次性用品
- **快速 API**：给脚本调用的取邮箱 / 取验证码 / 轮询等码接口
- **移动端适配**：响应式布局 + 列表/正文标签切换

## 快速开始

```bash
npm install
node server.js   # 监听 127.0.0.1:8443
```

建议挂 nginx 反代 + 鉴权（如 `auth_request` 统一登录），不要直接暴露公网。

## 账号格式

```
email@outlook.com----password----client_id----refresh_token
```

`password` 可留空（读邮件只需要 refresh_token）。refresh_token 通过 Azure AD 应用授权获得，scope 需要 `Mail.Read offline_access`。

## 快速 API

| 接口 | 说明 |
|---|---|
| `GET /api/quick/random` | 随机取一个健康邮箱 |
| `GET /api/quick/latest?email=xx@outlook.com&top=5` | 取最新邮件列表 |
| `GET /api/quick/code?email=xx@outlook.com&minutes=10&sender=github` | 提取最近邮件中的验证码 |
| `GET /api/quick/wait-code?email=xx@outlook.com&timeout=60` | 轮询等待验证码（最长 120s） |

验证码返回示例：

```json
{
  "email": "xx@outlook.com",
  "code": "482913",
  "subject": "Your verification code",
  "from": "noreply@github.com",
  "received": "2026-08-18T14:55:00Z"
}
```

## 技术栈

Node.js + Express + better-sqlite3，零前端依赖（原生 JS）。

## License

MIT
