import net from "node:net";

type RedisValue = string | null;

const DEFAULT_TIMEOUT_MS = 1200;

function getRedisConfig() {
  const backend = process.env.STATE_BACKEND?.trim();
  if (backend && backend !== "redis") {
    return null;
  }

  const host = process.env.REDIS_HOST?.trim();
  if (!host) {
    return null;
  }
  const port = Number(process.env.REDIS_PORT ?? "6379");
  const password = process.env.REDIS_PASSWORD ?? "";
  const db = Number(process.env.REDIS_DB ?? "0");
  const connectTimeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_SEC ?? "1.2") * 1000;
  const ioTimeoutMs = Number(process.env.REDIS_IO_TIMEOUT_SEC ?? "1.2") * 1000;
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  if (!Number.isFinite(db) || db < 0) {
    return null;
  }
  return {
    host,
    port,
    password,
    db,
    connectTimeoutMs:
      Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0 ? connectTimeoutMs : DEFAULT_TIMEOUT_MS,
    ioTimeoutMs: Number.isFinite(ioTimeoutMs) && ioTimeoutMs > 0 ? ioTimeoutMs : DEFAULT_TIMEOUT_MS
  };
}

function encodeCommand(args: string[]): Buffer {
  const parts: string[] = [`*${args.length}\r\n`];
  for (const arg of args) {
    parts.push(`$${Buffer.byteLength(arg, "utf8")}\r\n${arg}\r\n`);
  }
  return Buffer.from(parts.join(""), "utf8");
}

function parseSingleResponse(buffer: Buffer, start: number): { value: RedisValue; next: number } | null {
  if (start >= buffer.length) {
    return null;
  }
  const type = String.fromCharCode(buffer[start]);
  const lineEnd = buffer.indexOf("\r\n", start + 1);
  if (lineEnd === -1) {
    return null;
  }
  const line = buffer.slice(start + 1, lineEnd).toString("utf8");
  if (type === "+") {
    return { value: line, next: lineEnd + 2 };
  }
  if (type === ":") {
    return { value: line, next: lineEnd + 2 };
  }
  if (type === "$") {
    const size = Number(line);
    if (size === -1) {
      return { value: null, next: lineEnd + 2 };
    }
    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + size;
    if (buffer.length < dataEnd + 2) {
      return null;
    }
    return { value: buffer.slice(dataStart, dataEnd).toString("utf8"), next: dataEnd + 2 };
  }
  if (type === "-") {
    throw new Error(`redis error: ${line}`);
  }
  throw new Error(`redis unsupported reply type: ${type}`);
}

async function sendRedisCommands(commands: string[][]): Promise<RedisValue[]> {
  const cfg = getRedisConfig();
  if (!cfg) {
    throw new Error("redis is not configured");
  }

  const queue: string[][] = [];
  if (cfg.password) {
    queue.push(["AUTH", cfg.password]);
  }
  if (cfg.db > 0) {
    queue.push(["SELECT", String(cfg.db)]);
  }
  queue.push(...commands);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: cfg.host,
      port: cfg.port,
      timeout: cfg.ioTimeoutMs
    });
    const chunks: Buffer[] = [];
    let done = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (err?: Error) => {
      if (done) {
        return;
      }
      done = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
      if (err) {
        reject(err);
        return;
      }

      try {
        const joined = Buffer.concat(chunks);
        const replies: RedisValue[] = [];
        let offset = 0;
        for (let i = 0; i < queue.length; i += 1) {
          const parsed = parseSingleResponse(joined, offset);
          if (!parsed) {
            throw new Error("redis incomplete response");
          }
          replies.push(parsed.value);
          offset = parsed.next;
        }
        resolve(replies.slice(queue.length - commands.length));
      } catch (e) {
        reject(e instanceof Error ? e : new Error("redis parse error"));
      }
    };

    timer = setTimeout(() => {
      finish(new Error("redis timeout"));
    }, Math.max(cfg.connectTimeoutMs, cfg.ioTimeoutMs));

    socket.on("connect", () => {
      for (const command of queue) {
        socket.write(encodeCommand(command));
      }
      socket.end();
    });

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("end", () => finish());
    socket.on("close", () => finish());
    socket.on("error", (err) => finish(err));
    socket.on("timeout", () => finish(new Error("redis socket timeout")));
  });
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  try {
    const [value] = await sendRedisCommands([["GET", key]]);
    if (!value) {
      return null;
    }
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) {
    return;
  }
  try {
    await sendRedisCommands([["SETEX", key, String(ttlSeconds), JSON.stringify(value)]]);
  } catch {
    // ignore redis failures
  }
}
