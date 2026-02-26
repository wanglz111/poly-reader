# Polymarket 5m Crypto 价格分析服务开发文档（基于真实库）

## 1. 目标

把当前 MySQL 监控数据做成一个可查询、可视化服务，核心用途是排查某一场次内：

- Polymarket 的 `up_buy_price`
- Token 的 Chainlink `mid price`（即 `chainlink_mid_price`）

并支持你后续优化下注算法。

---

## 2. 数据库现状（已按 `.env` 实库确认）

库名：`poly`  
主表：`price_snapshots_1s`

关键字段：

- `base_symbol`（token，例如 `btc/eth/sol`）
- `market_slug`（例如 `btc-updown-5m-1772076000`）
- `market_start_ts`（场次开始，Unix 秒）
- `market_end_ts`（场次结束，Unix 秒）
- `captured_at_ts`（采样时间，Unix 秒）
- `captured_at_iso`（ISO 时间）
- `up_buy_price`（Polymarket 价格）
- `chainlink_mid_price`（Token mid 价格）

说明：你说的“同一个时间戳拿 bet price 和 token price”是对的，这两组价格在同一表同一行，不需要跨表 join。

已有索引（对查询有帮助）：

- `uq_symbol_market_ts(base_symbol, market_slug, captured_at_ts)`
- `idx_market_ts(market_slug, captured_at_ts)`
- `idx_symbol_ts(base_symbol, captured_at_ts)`

---

## 3. 你新增的产品要求（本版已纳入）

1. `timezone` 只做两个可选项：
   - `UTC+8`
   - `Polymarket Time`
2. 时间不要手输：
   - 做成可点击下拉
   - 选项来自数据库已有场次
   - 展示格式类似 `MM-DD HH:mm ~ HH:mm`

---

## 4. 时间定义与 timezone 方案

## 4.1 数据内部统一

后端内部统一使用 Unix 秒（`market_start_ts`, `market_end_ts`, `captured_at_ts`）查询，避免时区混乱。

## 4.2 `Polymarket Time` 的定义

建议定义为 `UTC`（Polymarket 的市场时间本质上按 UTC 时间戳组织，slug 尾部就是 UTC 场次起点秒级时间）。

## 4.3 前端时区切换

前端只影响“展示标签”，不影响实际查询条件。

- `timezone=POLYMARKET` -> 按 UTC 展示
- `timezone=UTC8` -> 按 `Asia/Shanghai` 展示

---

## 5. API 设计（按你的筛选逻辑）

## 5.1 获取 token 列表

`GET /api/tokens`

返回：`["btc", "eth", "sol"]`

## 5.2 获取可选场次（用于下拉，不手输时间）

`GET /api/markets?token=btc&timezone=UTC8`

返回示例：

```json
[
  {
    "market_slug": "btc-updown-5m-1772076000",
    "market_start_ts": 1772076000,
    "market_end_ts": 1772076300,
    "label": "02-26 11:20 ~ 11:25"
  },
  {
    "market_slug": "btc-updown-5m-1772075700",
    "market_start_ts": 1772075700,
    "market_end_ts": 1772076000,
    "label": "02-26 11:15 ~ 11:20"
  }
]
```

下拉项 value 推荐用：`market_slug`（唯一且稳定）。

## 5.3 查询某场次价格走势（核心）

`GET /api/price-series?token=btc&market_slug=btc-updown-5m-1772076000&timezone=POLYMARKET`

返回示例：

```json
{
  "meta": {
    "token": "btc",
    "market_slug": "btc-updown-5m-1772076000",
    "market_start_ts": 1772076000,
    "market_end_ts": 1772076300,
    "timezone": "POLYMARKET"
  },
  "series": [
    { "ts": 1772076017, "up_buy_price": 0.33, "chainlink_mid_price": 68129.35 },
    { "ts": 1772076018, "up_buy_price": 0.33, "chainlink_mid_price": 68129.35 }
  ]
}
```

---

## 6. SQL 查询（直接对现表）

## 6.1 token 下拉

```sql
SELECT DISTINCT base_symbol
FROM price_snapshots_1s
ORDER BY base_symbol;
```

## 6.2 场次下拉（按 token）

```sql
SELECT
  market_slug,
  market_start_ts,
  market_end_ts,
  COUNT(*) AS points
FROM price_snapshots_1s
WHERE base_symbol = ?
GROUP BY market_slug, market_start_ts, market_end_ts
ORDER BY market_start_ts DESC
LIMIT 500;
```

## 6.3 场次走势

```sql
SELECT
  captured_at_ts,
  up_buy_price,
  chainlink_mid_price
FROM price_snapshots_1s
WHERE base_symbol = ?
  AND market_slug = ?
ORDER BY captured_at_ts ASC;
```

备注：你原先提的 `token + market_startat + market_end` 也可支持。  
建议接口层优先用 `market_slug`（更稳），同时兼容 `market_start_ts + market_end_ts` 作为可选过滤。

---

## 7. 前端交互设计（关键点：不手输时间）

页面 `/dashboard`：

1. Token 下拉：来自 `/api/tokens`
2. Timezone 下拉：固定两项
   - `Polymarket Time`
   - `UTC+8`
3. 场次下拉：依赖 token + timezone，来自 `/api/markets`
   - 文案如 `02-26 11:20 ~ 11:25`
   - 点击选择，不允许自由输入
4. 查询按钮：请求 `/api/price-series`

图表：

- 一张双 Y 轴折线图
- 左轴：`up_buy_price`（0~1）
- 右轴：`chainlink_mid_price`
- X 轴：`captured_at_ts`（按当前 timezone 格式化显示）

---

## 8. Vercel 部署与数据库连接方案

## 8.1 环境变量

继续用你现有变量：

- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_DATABASE`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `DATABASE_URL`（可选）

在 Vercel 的 `Production / Preview / Development` 分环境配置。

## 8.2 连接池策略（Serverless 必须）

- 使用模块级单例池（global cache）
- `connectionLimit` 建议 `5~8`
- 仅只读查询
- 避免事务和长连接

Node `mysql2/promise` 推荐配置：

- `waitForConnections: true`
- `connectionLimit: 8`
- `queueLimit: 0`
- `timezone: 'Z'`

## 8.3 网络策略

你的 MySQL 是公网 IP（`43.167.241.33:3306`），要确保：

- MySQL 安全组允许 Vercel 出口访问（或使用稳定代理层）
- 生产密码不要写在仓库 `.env`
- 建议新增只读账号给服务查询

---

## 9. 参数校验规则

- `token` 必填，限制在白名单（从 DB 读取缓存）
- `timezone` 必填，枚举：`POLYMARKET | UTC8`
- `market_slug` 必填（或 `market_start_ts + market_end_ts`）
- 查询结果为空时返回空数组，不报错

---

## 10. 开发里程碑

### M1（后端）

- 建立 Next.js 项目
- 接入 MySQL 连接池
- 完成 `/api/tokens` `/api/markets` `/api/price-series`

### M2（前端）

- 筛选区 3 个下拉（token/timezone/场次）
- 双价格走势图
- 加载态/空态/错误态

### M3（上线）

- Vercel 环境变量配置
- 联调生产库
- 验证慢查询与连接数

---

## 11. 下一步

如果你确认这份文档，我下一步直接开始写可运行代码（M1+M2），先把接口和可点击场次下拉页面跑起来。
