const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { Pool } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.ini");
const session = { token: null, cookie: null };
let databasePool;

const parseIni = (content) => {
  const result = {};
  let section = "default";
  result[section] = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed.slice(1, -1);
      result[section] ||= {};
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator > 0) {
      result[section][trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    }
  }
  return result;
};

const readConfig = () => parseIni(fs.readFileSync(CONFIG_PATH, "utf8"));

const getRuntimeConfig = () => {
  const config = readConfig();
  return {
    database: {
      ...config.database,
      connection_string: process.env.DATABASE_URL || config.database?.connection_string
    },
    api: {
      ...config.api,
      base_url: process.env.NEON_API_URL || config.api?.base_url
    },
    auth: {
      ...config.auth,
      base_url: process.env.NEON_AUTH_URL || config.auth?.base_url,
      login_path: process.env.NEON_AUTH_LOGIN_PATH || config.auth?.login_path
    }
  };
};

const getDatabasePool = () => {
  if (!databasePool) {
    const connectionString = getRuntimeConfig().database.connection_string;
    if (!connectionString) throw new Error("connection_string não configurada em [database] no config.ini.");
    databasePool = new Pool({ connectionString });
  }
  return databasePool;
};

const ensureDebugTable = async (pool) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS debug_registros (
      id BIGSERIAL PRIMARY KEY,
      mensagem TEXT NOT NULL,
      origem TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const sendJson = (response, status, data) => {
  const body = JSON.stringify(data);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(body);
};

const readBody = async (request) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
};

const findToken = (value) => {
  if (!value || typeof value !== "object") return null;
  for (const key of ["access_token", "token", "id_token", "idToken"]) {
    if (typeof value[key] === "string") return value[key];
  }
  for (const child of Object.values(value)) {
    const token = findToken(child);
    if (token) return token;
  }
  return null;
};

const remoteRequest = async (url, options = {}) => {
  const headers = { Accept: "application/json", ...options.headers };
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { response, data };
};

const login = async (request, response) => {
  try {
    const config = getRuntimeConfig().auth;
    const body = await readBody(request);
    const email = body.email || config.email;
    const password = body.password || config.password;
    const loginUrl = `${config.base_url.replace(/\/$/, "")}${config.login_path || "/sign-in/email"}`;
    const result = await remoteRequest(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (!result.response.ok) {
      sendJson(response, result.response.status, result.data);
      return;
    }

    session.token = findToken(result.data);
    session.cookie = result.response.headers.get("set-cookie");
    sendJson(response, 200, {
      message: "Login enviado ao Neon Auth.",
      token_received: Boolean(session.token),
      session_cookie_received: Boolean(session.cookie)
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
};

const database = async (request, response, method, requestUrl) => {
  try {
    const body = method === "POST" ? await readBody(request) : {};
    const table = requestUrl.searchParams.get("table") || body.table;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table || "")) {
      sendJson(response, 400, { error: "Nome de tabela inválido." });
      return;
    }

    delete body.table;
    const pool = getDatabasePool();
    if (table === "debug_registros") await ensureDebugTable(pool);
    let result;
    if (method === "GET") {
      result = await pool.query(`SELECT * FROM "${table}" ORDER BY 1 DESC LIMIT 100`);
    } else {
      const columns = Object.keys(body);
      if (!columns.length || columns.some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))) {
        sendJson(response, 400, { error: "O JSON precisa ter colunas válidas para a tabela." });
        return;
      }
      const values = columns.map((column) => body[column]);
      const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
      const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
      result = await pool.query(`INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders}) RETURNING *`, values);
    }
    sendJson(response, 200, Array.isArray(result.rows) ? result.rows : []);
  } catch (error) {
    if (error.code === "42501") {
      sendJson(response, 403, { error: "O usuário do banco não tem permissão no schema public. Execute os GRANTs de debug/schema.sql usando o proprietário do banco no Neon." });
      return;
    }
    sendJson(response, 500, { error: `Falha no PostgreSQL: ${error.message}` });
  }
};

const serveStatic = (request, response) => {
  const requestedPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  let filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, requestedPath === "/debug/" ? "debug.html" : "index.html");
  }
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".sql": "text/plain; charset=utf-8" }[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(response);
};

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, "http://localhost");
  if (request.method === "POST" && requestUrl.pathname === "/api/login") return login(request, response);
  if (request.method === "GET" && requestUrl.pathname === "/api/db/read") return database(request, response, "GET", requestUrl);
  if (request.method === "POST" && requestUrl.pathname === "/api/db/write") return database(request, response, "POST", requestUrl);
  serveStatic(request, response);
});

server.listen(8000, "127.0.0.1", () => {
  console.log("Debug server: http://localhost:8000/debug/");
});