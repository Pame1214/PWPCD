const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { URL } = require("node:url");
const { Pool } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = fs.existsSync(path.join(ROOT, "config.ini"))
  ? path.join(ROOT, "config.ini")
  : path.join(ROOT, "Config.ini");
const SECRET_PATH = path.join(ROOT, "senha");
const session = { token: null, cookie: null };
const appSessions = new Map();
let databasePool;

const hashPassword = (passwordHash) => {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derivedKey = crypto.scryptSync(passwordHash, salt, 64);
  return `scrypt$${salt}$${derivedKey.toString("base64url")}`;
};

const verifyPassword = (passwordHash, storedHash) => {
  const [, salt, encodedKey] = String(storedHash).split("$");
  if (!salt || !encodedKey) return false;
  const expected = Buffer.from(encodedKey, "base64url");
  const actual = crypto.scryptSync(passwordHash, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const hashesMatch = (left, right) => {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

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

const getConnectionString = (config) => {
  const configuredSecret = config.database?.senha;
  if (configuredSecret && fs.existsSync(path.resolve(ROOT, configuredSecret))) {
    return fs.readFileSync(path.resolve(ROOT, configuredSecret), "utf8").trim();
  }
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return config.database?.connection_string;
};

const runNeonConnectionString = ({ projectId, branch, roleName, databaseName }) => new Promise((resolve, reject) => {
  const args = ["connection-string", branch, "--project-id", projectId, "--pooled"];
  if (roleName) args.push("--role-name", roleName);
  if (databaseName) args.push("--database-name", databaseName);

  execFile("neon", args, { timeout: 30000, maxBuffer: 10000 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr.trim() || error.message));
      return;
    }
    const connectionString = stdout.trim();
    if (!connectionString.startsWith("postgresql://")) {
      reject(new Error("O Neon CLI não retornou uma connection string PostgreSQL válida."));
      return;
    }
    resolve(connectionString);
  });
});

const saveDatabaseConnection = (connectionString) => {
  databasePool?.end().catch(() => {});
  databasePool = null;
};

const setupNeon = async (request, response) => {
  try {
    const body = await readBody(request);
    const projectId = String(body.projectId || "").trim();
    const branch = String(body.branch || "").trim();
    const roleName = String(body.roleName || "").trim();
    const databaseName = String(body.databaseName || "").trim();
    if (!projectId || !branch) {
      sendJson(response, 400, { error: "Informe o ID do projeto e o branch do Neon." });
      return;
    }

    const connectionString = await runNeonConnectionString({ projectId, branch, roleName, databaseName });
    saveDatabaseConnection(connectionString);
    sendJson(response, 200, {
      ok: true,
      message: "Connection string salva no arquivo local ignorado senha."
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message,
      hint: "Instale e autentique o Neon CLI com: npm install -g neonctl && neon auth"
    });
  }
};

const getRuntimeConfig = () => {
  const config = readConfig();
  return {
    database: {
      ...config.database,
      connection_string: getConnectionString(config)
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
    if (!connectionString) throw new Error("O arquivo local senha está vazio ou não existe.");
    if (!connectionString.startsWith("postgresql://")) {
      throw new Error("O arquivo local senha não contém uma connection string PostgreSQL válida.");
    }
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

const validateIdentifier = (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value || "");

const getTable = (requestUrl, body) => {
  const table = requestUrl.searchParams.get("table") || body.table;
  if (!validateIdentifier(table)) throw new Error("Nome de tabela inválido.");
  return table;
};

const sendJson = (response, status, data) => {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  response.end(body);
};

const startAppSession = (response, username) => {
  const token = crypto.randomBytes(32).toString("base64url");
  appSessions.set(token, { username, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  response.setHeader("Set-Cookie", `pwpcd_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
};

const getAppSession = (request) => {
  const cookies = request.headers.cookie || "";
  const token = cookies.split(";").map((item) => item.trim()).find((item) => item.startsWith("pwpcd_session="))?.split("=")[1];
  const current = token ? appSessions.get(token) : null;
  if (!current || current.expiresAt < Date.now()) return null;
  return current;
};

const currentUser = (request, response) => {
  const currentSession = getAppSession(request);
  sendJson(response, 200, {
    authenticated: Boolean(currentSession),
    username: currentSession?.username || null
  });
};

const logout = (request, response) => {
  const cookies = request.headers.cookie || "";
  const token = cookies.split(";").map((item) => item.trim()).find((item) => item.startsWith("pwpcd_session="))?.split("=")[1];
  if (token) appSessions.delete(token);
  response.setHeader("Set-Cookie", "pwpcd_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  sendJson(response, 200, { ok: true });
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
    const body = await readBody(request);
    const username = String(body.username || "").trim();
    const passwordHash = String(body.password_hash || "").trim();
    if (!username || !passwordHash || !/^[a-f0-9]{64}$/i.test(passwordHash)) {
      sendJson(response, 400, { error: "Usuário e hash SHA-256 válidos são obrigatórios." });
      return;
    }
    const result = await getDatabasePool().query(
      "SELECT username, password_hash, legacy_password FROM app_users WHERE username = $1",
      [username]
    );
    const user = result.rows[0];
    if (!user) {
      sendJson(response, 401, { error: "Usuário ou senha inválidos." });
      return;
    }
    if (user.legacy_password) {
      if (!hashesMatch(passwordHash, sha256(user.legacy_password))) {
        sendJson(response, 401, { error: "Usuário ou senha inválidos." });
        return;
      }
      const migratedHash = hashPassword(passwordHash);
      await getDatabasePool().query(
        "UPDATE app_users SET password_hash = $1, legacy_password = NULL WHERE id = $2",
        [migratedHash, user.id]
      );
      startAppSession(response, user.username);
      sendJson(response, 200, { ok: true, username: user.username, migrated: true });
      return;
    }
    if (!verifyPassword(passwordHash, user.password_hash)) {
      sendJson(response, 401, { error: "Usuário ou senha inválidos." });
      return;
    }
    startAppSession(response, user.username);
    sendJson(response, 200, { ok: true, username: user.username });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
};

const register = async (request, response) => {
  try {
    const body = await readBody(request);
    const username = String(body.username || "").trim();
    const passwordHash = String(body.password_hash || "").trim();
    if (!/^[A-Za-z0-9_.-]{3,80}$/.test(username) || !/^[a-f0-9]{64}$/i.test(passwordHash)) {
      sendJson(response, 400, { error: "Usuário ou hash SHA-256 inválido." });
      return;
    }
    const result = await getDatabasePool().query(
      "INSERT INTO app_users (username, password_hash) VALUES ($1, $2) RETURNING username",
      [username, hashPassword(passwordHash)]
    );
    startAppSession(response, result.rows[0].username);
    sendJson(response, 201, { ok: true, username: result.rows[0].username });
  } catch (error) {
    sendJson(response, error.code === "23505" ? 409 : 500, {
      error: error.code === "23505" ? "Esse usuário já existe." : `Falha no cadastro: ${error.message}`
    });
  }
};

const database = async (request, response, method, requestUrl) => {
  try {
    const body = method === "POST" ? await readBody(request) : {};
    const table = getTable(requestUrl, body);

    delete body.table;
    const pool = getDatabasePool();
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

const databaseHealth = async (response) => {
  try {
    const pool = getDatabasePool();
    const result = await pool.query("SELECT NOW() AS server_time, current_database() AS database, current_user AS user_name, version() AS version");
    sendJson(response, 200, { ok: true, ...result.rows[0] });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
};

const createRecord = async (request, response) => {
  try {
    const currentSession = getAppSession(request);
    if (!currentSession) {
      sendJson(response, 401, { error: "Faça login antes de salvar dados." });
      return;
    }
    const body = await readBody(request);
    const mensagem = String(body.mensagem || "").trim();
    const origem = String(body.origem || "site").trim();
    if (!mensagem || mensagem.length > 5000 || origem.length > 120) {
      sendJson(response, 400, { error: "Informe uma mensagem válida e uma origem de até 120 caracteres." });
      return;
    }

    const pool = getDatabasePool();
    const result = await pool.query(
      "INSERT INTO debug_registros (mensagem, origem) VALUES ($1, $2) RETURNING id, mensagem, origem, criado_em",
      [mensagem, origem || "site"]
    );
    sendJson(response, 201, { ok: true, username: currentSession.username, record: result.rows[0] });
  } catch (error) {
    sendJson(response, 500, { error: `Falha ao salvar no PostgreSQL: ${error.message}` });
  }
};

const databaseTables = async (response) => {
  try {
    const pool = getDatabasePool();
    const result = await pool.query(`
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);
    sendJson(response, 200, result.rows);
  } catch (error) {
    sendJson(response, 500, { error: `Falha ao listar tabelas: ${error.message}` });
  }
};

const databaseColumns = async (response, requestUrl) => {
  try {
    const table = getTable(requestUrl, {});
    const pool = getDatabasePool();
    const result = await pool.query(`
      SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = $1
      ORDER BY table_schema, ordinal_position
    `, [table]);
    sendJson(response, 200, result.rows);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
};

const databaseQuery = async (request, response) => {
  try {
    const body = await readBody(request);
    const sql = String(body.sql || "").trim();
    if (!/^(SELECT|WITH|SHOW|EXPLAIN)\b/i.test(sql) || /;\s*\S/.test(sql)) {
      sendJson(response, 400, { error: "A consulta livre aceita apenas SELECT, WITH, SHOW ou EXPLAIN, em um único comando." });
      return;
    }
    const result = await getDatabasePool().query(sql);
    sendJson(response, 200, { row_count: result.rowCount, rows: result.rows, fields: result.fields.map((field) => field.name) });
  } catch (error) {
    sendJson(response, 500, { error: `Falha na consulta: ${error.message}` });
  }
};

const databaseMutation = async (request, response, method) => {
  try {
    const body = await readBody(request);
    const table = body.table;
    if (!validateIdentifier(table)) throw new Error("Nome de tabela inválido.");
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("O id precisa ser um número inteiro positivo.");
    const pool = getDatabasePool();
    let result;

    if (method === "DELETE") {
      result = await pool.query(`DELETE FROM "${table}" WHERE id = $1 RETURNING *`, [id]);
    } else {
      const updates = body.values;
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new Error("Envie um objeto values com as colunas a atualizar.");
      const columns = Object.keys(updates).filter((column) => column !== "id");
      if (!columns.length || columns.some((column) => !validateIdentifier(column))) throw new Error("Nenhuma coluna válida para atualizar.");
      const values = columns.map((column) => updates[column]);
      const assignments = columns.map((column, index) => `"${column}" = $${index + 1}`).join(", ");
      result = await pool.query(`UPDATE "${table}" SET ${assignments} WHERE id = $${values.length + 1} RETURNING *`, [...values, id]);
    }
    sendJson(response, 200, { affected: result.rowCount, rows: result.rows });
  } catch (error) {
    sendJson(response, 400, { error: `Falha na alteração: ${error.message}` });
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
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    response.end();
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/login") return login(request, response);
  if (request.method === "POST" && requestUrl.pathname === "/api/register") return register(request, response);
  if (request.method === "GET" && requestUrl.pathname === "/api/session") return currentUser(request, response);
  if (request.method === "POST" && requestUrl.pathname === "/api/logout") return logout(request, response);
  if (request.method === "POST" && requestUrl.pathname === "/api/records") return createRecord(request, response);
  if (request.method === "POST" && requestUrl.pathname === "/api/neon/setup") return setupNeon(request, response);
  if (request.method === "GET" && requestUrl.pathname === "/api/db/health") return databaseHealth(response);
  if (request.method === "GET" && requestUrl.pathname === "/api/db/tables") return databaseTables(response);
  if (request.method === "GET" && requestUrl.pathname === "/api/db/columns") return databaseColumns(response, requestUrl);
  if (request.method === "POST" && requestUrl.pathname === "/api/db/query") return databaseQuery(request, response);
  if (request.method === "POST" && requestUrl.pathname === "/api/db/update") return databaseMutation(request, response, "UPDATE");
  if (request.method === "POST" && requestUrl.pathname === "/api/db/delete") return databaseMutation(request, response, "DELETE");
  if (request.method === "GET" && requestUrl.pathname === "/api/db/read") return database(request, response, "GET", requestUrl);
  if (request.method === "POST" && requestUrl.pathname === "/api/db/write") return database(request, response, "POST", requestUrl);
  if (requestUrl.pathname.startsWith("/api/")) {
    sendJson(response, 405, {
      error: "Método HTTP não suportado para este endpoint.",
      method: request.method,
      path: requestUrl.pathname
    });
    return;
  }
  serveStatic(request, response);
});

const PORT = Number(process.env.PORT) || 8000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PWPCD server listening on port ${PORT}`);
});