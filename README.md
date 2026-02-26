# poly-reader

Polymarket 5m crypto 场次价格查询服务（Next.js + MySQL）。

## 功能

- 按 `token` + `日期/小时` 筛选价格走势
- 先选日期再选小时（来自数据库聚合小时桶）
- 同图展示两条线：
  - `up_buy_price`（Polymarket）
  - `chainlink_mid_price`（Token）
- `timezone` 仅两项：`Polymarket Time` / `UTC+8`

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
- 可选 Redis 缓存（`REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_DB`），用于降低 MySQL 查询频率
