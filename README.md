# poly-reader

Polymarket 5m crypto 场次价格查询服务（Next.js + MySQL）。

## 功能

- 按 `token` + `日期/小时` 筛选价格走势
- 先选日期再选小时（来自数据库聚合小时桶）
- 同图展示两条线：
  - `up_buy_price`（Polymarket）
  - `chainlink_mid_price`（Token）
- `timezone` 仅两项：`Polymarket Time (ET)` / `UTC+8`

## 开发启动

1. 安装依赖

```bash
npm install
```

2. 配置环境变量（参考 `.env`）

3. 启动

```bash
npm run dev
```

浏览器打开 `http://localhost:3000/dashboard`。
同一局域网设备可访问 `http://<你的内网IP>:3000/dashboard`。

查看本机内网 IP（macOS）：

```bash
ipconfig getifaddr en0
```

## API

- `GET /api/tokens`
- `GET /api/markets?token=btc&recent_hours=720&limit=720`
- `GET /api/price-series?token=btc&hour_start_ts=1772076000&timezone=UTC8`
- `GET /api/price-series?token=btc&market_startat=1772076000&market_end=1772076300&timezone=UTC8`

## 说明

- 表名固定：`v_chainlink_polymarket_join`
- 使用 MySQL 连接池单例，适配 Vercel Serverless 场景
- 可选 Redis 缓存（`STATE_BACKEND=redis` + `REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_DB`），用于降低 MySQL 查询频率
- 支持 MySQL/Redis 网络超时配置（`MYSQL_*_TIMEOUT_SEC`、`REDIS_*_TIMEOUT_SEC`），避免慢查询长期阻塞请求
- 历史数据会写入更长 TTL 的 Redis 键（按小时 markets 全量缓存、price-series 多别名键），尽量让历史查询直接命中 Redis
- 提供 `/api/cache-sync` 定时预热接口，可每 5 分钟把最新闭盘数据从 MySQL 同步写入 Redis（支持 `CACHE_SYNC_SECRET` 鉴权）
