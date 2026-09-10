import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Pool do Postgres (Neon). Reaproveitado entre requisições dentro da mesma
// instância do Worker. A connection string vem da variável de ambiente
// DATABASE_URL, configurada como Secret no dashboard do Cloudflare
// (Workers & Pages > pwpcd > Settings > Variables and Secrets).
// ---------------------------------------------------------------------------
let pool;
const getPool = (env) => {
  if (!pool) {
    if (!env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL não configurada. Adicione a connection string do Neon como Secret nas configurações do Worker."
      );
    }
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 3 });
  }
  return pool;
};

// ---------------------------------------------------------------------------
// Helpers de resposta
// ---------------------------------------------------------------------------
const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });

const readJson = async (request) => {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
};

const validateIdentifier = (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value || "");

const getTable = (url, body) => {
  const table = url.searchParams.get("table") || body?.table;
  if (!validateIdentifier(table)) throw new Error("Nome de tabela inválido.");
  return table;
};

// ---------------------------------------------------------------------------
// Senhas: o front-end já envia um SHA-256 hex da senha digitada. Aqui a gente
// deriva esse valor com PBKDF2 (Web Crypto, nativo no Workers) antes de
// guardar, para não salvar o hash do cliente "cru" no banco.
// ---------------------------------------------------------------------------
const PBKDF2_ITERATIONS = 100000;

const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
};

const deriveKey = async (value, saltBytes, iterations) => {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(value),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
};

const hashPassword = async (passwordHash) => {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveKey(passwordHash, saltBytes, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(saltBytes)}$${derived}`;
};

const verifyPassword = async (passwordHash, storedHash) => {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const saltBytes = fromHex(parts[2]);
  const expectedHex = parts[3];
  const actualHex = await deriveKey(passwordHash, saltBytes, iterations);
  if (actualHex.length !== expectedHex.length) return false;
  // comparação em tempo constante
  let diff = 0;
  for (let i = 0; i < actualHex.length; i++) diff |= actualHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
};

// ---------------------------------------------------------------------------
// Sessões: guardadas no Postgres (app_sessions) em vez de memória, porque um
// Worker pode rodar em várias instâncias ao mesmo tempo — uma Map local
// derrubaria o login aleatoriamente.
// ---------------------------------------------------------------------------
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toHex(bytes);
};

const SESSION_COOKIE = "pwpcd_session";

const getCookie = (request, name) => {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
};

const createSession = async (env, username) => {
  const token = randomToken();
  const pgPool = getPool(env);
  await pgPool.query(
    "INSERT INTO app_sessions (token, username, expires_at) VALUES ($1, $2, NOW() + INTERVAL '8 hours')",
    [token, username]
  );
  return token;
};

const getSession = async (env, token) => {
  if (!token) return null;
  const pgPool = getPool(env);
  const result = await pgPool.query(
    "SELECT username FROM app_sessions WHERE token = $1 AND expires_at > NOW()",
    [token]
  );
  return result.rows[0] || null;
};

const deleteSession = async (env, token) => {
  if (!token) return;
  await getPool(env).query("DELETE FROM app_sessions WHERE token = $1", [token]);
};

const sessionCookieHeader = (token) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`;

const clearSessionCookieHeader = () =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

// ---------------------------------------------------------------------------
// Rotas de autenticação
// ---------------------------------------------------------------------------
const login = async (request, env) => {
  const body = await readJson(request);
  const username = String(body.username || "").trim();
  const passwordHash = String(body.password_hash || "").trim();
  if (!username || !/^[a-f0-9]{64}$/i.test(passwordHash)) {
    return json({ error: "Usuário e hash SHA-256 válidos são obrigatórios." }, 400);
  }

  const pgPool = getPool(env);
  const result = await pgPool.query(
    "SELECT id, username, password_hash FROM app_users WHERE username = $1",
    [username]
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(passwordHash, user.password_hash))) {
    return json({ error: "Usuário ou senha inválidos." }, 401);
  }

  const token = await createSession(env, user.username);
  return json({ ok: true, username: user.username }, 200, { "Set-Cookie": sessionCookieHeader(token) });
};

const register = async (request, env) => {
  const body = await readJson(request);
  const username = String(body.username || "").trim();
  const passwordHash = String(body.password_hash || "").trim();
  if (!/^[A-Za-z0-9_.-]{3,80}$/.test(username) || !/^[a-f0-9]{64}$/i.test(passwordHash)) {
    return json({ error: "Usuário ou hash SHA-256 inválido." }, 400);
  }

  try {
    const stored = await hashPassword(passwordHash);
    const pgPool = getPool(env);
    const result = await pgPool.query(
      "INSERT INTO app_users (username, password_hash) VALUES ($1, $2) RETURNING username",
      [username, stored]
    );
    const token = await createSession(env, result.rows[0].username);
    return json(
      { ok: true, username: result.rows[0].username },
      201,
      { "Set-Cookie": sessionCookieHeader(token) }
    );
  } catch (error) {
    if (error.code === "23505") return json({ error: "Esse usuário já existe." }, 409);
    return json({ error: `Falha no cadastro: ${error.message}` }, 500);
  }
};

const session = async (request, env) => {
  const token = getCookie(request, SESSION_COOKIE);
  const current = await getSession(env, token);
  return json({ authenticated: Boolean(current), username: current?.username || null });
};

const logout = async (request, env) => {
  const token = getCookie(request, SESSION_COOKIE);
  await deleteSession(env, token);
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookieHeader() });
};

const createRecord = async (request, env) => {
  const token = getCookie(request, SESSION_COOKIE);
  const current = await getSession(env, token);
  if (!current) return json({ error: "Faça login antes de salvar dados." }, 401);

  const body = await readJson(request);
  const mensagem = String(body.mensagem || "").trim();
  const origem = String(body.origem || "site").trim();
  if (!mensagem || mensagem.length > 5000 || origem.length > 120) {
    return json({ error: "Informe uma mensagem válida e uma origem de até 120 caracteres." }, 400);
  }

  const pgPool = getPool(env);
  const result = await pgPool.query(
    "INSERT INTO debug_registros (mensagem, origem) VALUES ($1, $2) RETURNING id, mensagem, origem, criado_em",
    [mensagem, origem]
  );
  return json({ ok: true, username: current.username, record: result.rows[0] }, 201);
};

// ---------------------------------------------------------------------------
// Painel de debug do banco (usado por debug.html)
// ---------------------------------------------------------------------------
const neonSetup = async () =>
  json(
    {
      ok: false,
      error: "Configuração automática via CLI não está disponível em produção.",
      hint: "Copie a connection string do Neon e salve como Secret DATABASE_URL nas configurações do Worker no dashboard do Cloudflare."
    },
    501
  );

const databaseHealth = async (env) => {
  const pgPool = getPool(env);
  const result = await pgPool.query(
    "SELECT NOW() AS server_time, current_database() AS database, current_user AS user_name, version() AS version"
  );
  return json({ ok: true, ...result.rows[0] });
};

const databaseTables = async (env) => {
  const pgPool = getPool(env);
  const result = await pgPool.query(`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `);
  return json(result.rows);
};

const databaseColumns = async (env, url) => {
  const table = getTable(url, {});
  const pgPool = getPool(env);
  const result = await pgPool.query(
    `
    SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = $1
    ORDER BY table_schema, ordinal_position
  `,
    [table]
  );
  return json(result.rows);
};

const databaseQuery = async (request, env) => {
  const body = await readJson(request);
  const sql = String(body.sql || "").trim();
  if (!/^(SELECT|WITH|SHOW|EXPLAIN)\b/i.test(sql) || /;\s*\S/.test(sql)) {
    return json({ error: "A consulta livre aceita apenas SELECT, WITH, SHOW ou EXPLAIN, em um único comando." }, 400);
  }
  const pgPool = getPool(env);
  const result = await pgPool.query(sql);
  return json({ row_count: result.rowCount, rows: result.rows, fields: result.fields.map((f) => f.name) });
};

const databaseRead = async (env, url) => {
  const table = getTable(url, {});
  const pgPool = getPool(env);
  const result = await pgPool.query(`SELECT * FROM "${table}" ORDER BY 1 DESC LIMIT 100`);
  return json(result.rows);
};

const databaseWrite = async (request, env, url) => {
  const body = await readJson(request);
  const table = getTable(url, body);
  delete body.table;
  const columns = Object.keys(body);
  if (!columns.length || columns.some((c) => !validateIdentifier(c))) {
    return json({ error: "O JSON precisa ter colunas válidas para a tabela." }, 400);
  }
  const values = columns.map((c) => body[c]);
  const quotedColumns = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const pgPool = getPool(env);
  const result = await pgPool.query(
    `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  return json(result.rows);
};

const databaseMutation = async (request, env, method) => {
  const body = await readJson(request);
  const table = body.table;
  if (!validateIdentifier(table)) return json({ error: "Nome de tabela inválido." }, 400);
  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return json({ error: "O id precisa ser um número inteiro positivo." }, 400);
  }

  const pgPool = getPool(env);
  let result;
  if (method === "DELETE") {
    result = await pgPool.query(`DELETE FROM "${table}" WHERE id = $1 RETURNING *`, [id]);
  } else {
    const updates = body.values;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return json({ error: "Envie um objeto values com as colunas a atualizar." }, 400);
    }
    const columns = Object.keys(updates).filter((c) => c !== "id");
    if (!columns.length || columns.some((c) => !validateIdentifier(c))) {
      return json({ error: "Nenhuma coluna válida para atualizar." }, 400);
    }
    const values = columns.map((c) => updates[c]);
    const assignments = columns.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
    result = await pgPool.query(
      `UPDATE "${table}" SET ${assignments} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, id]
    );
  }
  return json({ affected: result.rowCount, rows: result.rows });
};

// ---------------------------------------------------------------------------
// Roteador principal
// ---------------------------------------------------------------------------
const routes = [
  ["POST", "/api/login", (request, env) => login(request, env)],
  ["POST", "/api/register", (request, env) => register(request, env)],
  ["GET", "/api/session", (request, env) => session(request, env)],
  ["POST", "/api/logout", (request, env) => logout(request, env)],
  ["POST", "/api/records", (request, env) => createRecord(request, env)],
  ["POST", "/api/neon/setup", () => neonSetup()],
  ["GET", "/api/db/health", (request, env) => databaseHealth(env)],
  ["GET", "/api/db/tables", (request, env) => databaseTables(env)],
  ["GET", "/api/db/columns", (request, env, url) => databaseColumns(env, url)],
  ["POST", "/api/db/query", (request, env) => databaseQuery(request, env)],
  ["POST", "/api/db/update", (request, env) => databaseMutation(request, env, "UPDATE")],
  ["POST", "/api/db/delete", (request, env) => databaseMutation(request, env, "DELETE")],
  ["GET", "/api/db/read", (request, env, url) => databaseRead(env, url)],
  ["POST", "/api/db/write", (request, env, url) => databaseWrite(request, env, url)]
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const route = routes.find(([method, path]) => method === request.method && path === url.pathname);
      if (!route) {
        return json(
          { error: "Método HTTP não suportado para este endpoint.", method: request.method, path: url.pathname },
          405
        );
      }
      try {
        return await route[2](request, env, url);
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // Qualquer outra rota é arquivo estático (index.html, categorias.html, Css/, Js/, Defs/, debug/...)
    return env.ASSETS.fetch(request);
  }
};
