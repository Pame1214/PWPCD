import { Buffer } from "node:buffer";
import { createHash, pbkdf2, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";

const SESSION_COOKIE = "pwpcd_session";
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_JSON_BYTES = 64 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const deriveScrypt = promisify(scrypt);
const derivePbkdf2 = promisify(pbkdf2);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
});

const readJson = async (request) => {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "Envie um corpo JSON.");
  if (!request.body) throw new HttpError(400, "Corpo JSON inválido.");
  if (Number(request.headers.get("Content-Length")) > MAX_JSON_BYTES) {
    throw new HttpError(413, "A requisição é grande demais.");
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_JSON_BYTES) throw new HttpError(413, "A requisição é grande demais.");
    text += decoder.decode(chunk, { stream: true });
  }

  let data;
  try {
    data = JSON.parse(text + decoder.decode());
  } catch {
    throw new HttpError(400, "Corpo JSON inválido.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "Envie um objeto JSON.");
  }
  return data;
};

const db = (env) => {
  if (!env.DATABASE_URL) throw new HttpError(503, "Banco de dados indisponível.");
  return neon(env.DATABASE_URL, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const asText = (value) => typeof value === "string" ? value.trim() : "";
const equal = (left, right) => left.length === right.length && timingSafeEqual(left, right);

const credentials = async (request) => {
  const body = await readJson(request);
  const username = asText(body.username);
  const passwordHash = asText(body.password_hash);
  if (!username || username.length > 80 || !HASH_PATTERN.test(passwordHash)) {
    throw new HttpError(400, "Informe um usuário e uma senha válidos.");
  }
  return { username, passwordHash };
};

const verifyOldPassword = async (passwordHash, user) => {
  if (user.legacy_password) {
    return equal(Buffer.from(passwordHash, "hex"), Buffer.from(sha256(user.legacy_password), "hex"));
  }

  const stored = user.password_hash || "";
  const oldScrypt = /^scrypt\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(stored);
  if (oldScrypt) {
    const [, salt, key] = oldScrypt;
    return equal(await deriveScrypt(passwordHash, salt, 64), Buffer.from(key, "base64url"));
  }

  const oldPbkdf2 = /^pbkdf2\$100000\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored);
  if (oldPbkdf2) {
    const [, salt, key] = oldPbkdf2;
    const derived = await derivePbkdf2(passwordHash, Buffer.from(salt, "hex"), 100000, 32, "sha256");
    return equal(derived, Buffer.from(key, "hex"));
  }

  return false;
};

const sessionKey = (request) => {
  const cookies = request.headers.get("Cookie") || "";
  const value = cookies.split(";").map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return value && HASH_PATTERN.test(value) ? sha256(value) : null;
};

const sessionCookie = (value) => (
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? SESSION_SECONDS : 0}`
);

const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const signedIn = (username, token, status = 200) => (
  json({ ok: true, username }, status, { "Set-Cookie": sessionCookie(token) })
);

const register = async (request, env) => {
  const { username, passwordHash } = await credentials(request);
  if (!/^[A-Za-z0-9_.-]{3,80}$/.test(username)) {
    throw new HttpError(400, "Use de 3 a 80 letras, números, pontos, hífens ou sublinhados no usuário.");
  }

  const token = newToken();
  const sql = db(env);
  let rows;
  try {
    rows = await sql`
      WITH new_user AS (
        INSERT INTO public.app_users (username, password_hash)
        VALUES (${username}, public.crypt(${passwordHash}, public.gen_salt('bf', 12)))
        RETURNING username
      ), removed_sessions AS (
        DELETE FROM public.app_sessions WHERE expires_at <= NOW() OR token = ${sessionKey(request)}
      )
      INSERT INTO public.app_sessions (token, username, expires_at)
      SELECT ${sha256(token)}, username, NOW() + INTERVAL '8 hours' FROM new_user
      RETURNING username
    `;
  } catch (error) {
    if (error.code === "23505") throw new HttpError(409, "Esse usuário já existe.");
    throw error;
  }
  return signedIn(rows[0].username, token, 201);
};

const login = async (request, env) => {
  const { username, passwordHash } = await credentials(request);
  const sql = db(env);
  const [user] = await sql`
    SELECT id, username, password_hash, legacy_password,
      CASE WHEN legacy_password IS NULL AND password_hash LIKE '$2a$%'
        THEN password_hash = public.crypt(${passwordHash}, password_hash)
        ELSE FALSE END AS password_matches
    FROM public.app_users WHERE username = ${username}
  `;
  if (!user || (!user.password_matches && !await verifyOldPassword(passwordHash, user))) {
    throw new HttpError(401, "Usuário ou senha inválidos.");
  }

  const token = newToken();
  const key = sha256(token);
  const previousKey = sessionKey(request);
  if (user.password_matches) {
    await sql`
      WITH removed_sessions AS (
        DELETE FROM public.app_sessions WHERE expires_at <= NOW() OR token = ${previousKey}
      )
      INSERT INTO public.app_sessions (token, username, expires_at)
      VALUES (${key}, ${user.username}, NOW() + INTERVAL '8 hours')
    `;
  } else {
    const migrated = await sql`
      WITH upgraded AS (
        UPDATE public.app_users
        SET password_hash = public.crypt(${passwordHash}, public.gen_salt('bf', 12)), legacy_password = NULL
        WHERE id = ${user.id} AND password_hash IS NOT DISTINCT FROM ${user.password_hash}
          AND legacy_password IS NOT DISTINCT FROM ${user.legacy_password}
        RETURNING username
      ), removed_sessions AS (
        DELETE FROM public.app_sessions
        WHERE (expires_at <= NOW() OR token = ${previousKey}) AND EXISTS (SELECT 1 FROM upgraded)
      )
      INSERT INTO public.app_sessions (token, username, expires_at)
      SELECT ${key}, username, NOW() + INTERVAL '8 hours' FROM upgraded
      RETURNING username
    `;
    if (migrated.length === 0) throw new HttpError(409, "A conta foi atualizada. Tente entrar novamente.");
  }
  return signedIn(user.username, token);
};

const session = async (request, env) => {
  const key = sessionKey(request);
  if (!key) return json({ authenticated: false, username: null });
  const sql = db(env);
  const [current] = await sql`
    SELECT s.username FROM public.app_sessions AS s
    JOIN public.app_users AS u ON u.username = s.username
    WHERE s.token = ${key} AND s.expires_at > NOW()
  `;
  return json({ authenticated: Boolean(current), username: current?.username ?? null });
};

const logout = async (request, env) => {
  const key = sessionKey(request);
  if (key) {
    const sql = db(env);
    await sql`DELETE FROM public.app_sessions WHERE token = ${key}`;
  }
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("") });
};

const recordFields = (body, defaultOrigin) => {
  const mensagem = asText(body.mensagem);
  const origem = asText(body.origem) || defaultOrigin;
  if (!mensagem || mensagem.length > 5000 || origem.length > 120) {
    throw new HttpError(400, "Informe uma mensagem de até 5.000 caracteres e uma origem de até 120.");
  }
  return { mensagem, origem };
};

const createRecord = async (request, env) => {
  const key = sessionKey(request);
  if (!key) throw new HttpError(401, "Faça login antes de salvar dados.");
  const { mensagem, origem } = recordFields(await readJson(request), "site");
  const sql = db(env);
  const [record] = await sql`
    WITH active_session AS (
      SELECT s.username FROM public.app_sessions AS s
      JOIN public.app_users AS u ON u.username = s.username
      WHERE s.token = ${key} AND s.expires_at > NOW()
    ), inserted AS (
      INSERT INTO public.debug_registros (mensagem, origem)
      SELECT ${mensagem}, ${origem} FROM active_session
      RETURNING id, mensagem, origem, criado_em
    )
    SELECT inserted.*, active_session.username FROM inserted CROSS JOIN active_session
  `;
  if (!record) throw new HttpError(401, "Faça login antes de salvar dados.");
  const { username, ...fields } = record;
  return json({ ok: true, username, record: fields }, 201);
};

const health = async (request, env) => {
  try {
    const sql = db(env);
    const [state] = await sql`
      SELECT EXISTS (SELECT 1 FROM public.app_users) AS users_present,
             EXISTS (SELECT 1 FROM public.app_sessions) AS sessions_present,
             EXISTS (SELECT 1 FROM public.debug_registros) AS records_present,
             public.gen_salt('bf', 12) IS NOT NULL AS hashing_ready
    `;
    if (!state?.hashing_ready) throw new Error("pgcrypto unavailable");
    return json({ ok: true });
  } catch (error) {
    console.error("PWPCD: falha na verificação do banco", error.code || error.name);
    throw new HttpError(503, "Banco de dados indisponível. Verifique a conexão e o esquema.");
  }
};

const listRecords = async (request, env) => {
  const sql = db(env);
  const records = await sql`
    SELECT id, mensagem, origem, criado_em FROM public.debug_registros ORDER BY id DESC LIMIT 100
  `;
  return json(records);
};

const writeRecord = async (request, env) => {
  const { mensagem, origem } = recordFields(await readJson(request), "debug");
  const sql = db(env);
  const [record] = await sql`
    INSERT INTO public.debug_registros (mensagem, origem) VALUES (${mensagem}, ${origem})
    RETURNING id, mensagem, origem, criado_em
  `;
  return json({ record }, 201);
};

const recordId = (value) => {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : asText(value);
  if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw new HttpError(400, "Informe um ID de registro válido.");
  }
  return id;
};

const updateRecord = async (request, env) => {
  const body = await readJson(request);
  const id = recordId(body.id);
  const { mensagem, origem } = recordFields(body, "debug");
  const sql = db(env);
  const [record] = await sql`
    UPDATE public.debug_registros SET mensagem = ${mensagem}, origem = ${origem} WHERE id = ${id}
    RETURNING id, mensagem, origem, criado_em
  `;
  if (!record) throw new HttpError(404, "Registro não encontrado.");
  return json({ record });
};

const deleteRecord = async (request, env) => {
  const id = recordId((await readJson(request)).id);
  const sql = db(env);
  const [deleted] = await sql`DELETE FROM public.debug_registros WHERE id = ${id} RETURNING id`;
  if (!deleted) throw new HttpError(404, "Registro não encontrado.");
  return json({ ok: true, id: deleted.id });
};

const routes = new Map([
  ["/api/health", { method: "GET", handler: health }],
  ["/api/session", { method: "GET", handler: session }],
  ["/api/register", { method: "POST", handler: register, throttle: true }],
  ["/api/login", { method: "POST", handler: login, throttle: true }],
  ["/api/logout", { method: "POST", handler: logout }],
  ["/api/records", { method: "POST", handler: createRecord }],
  ["/api/db/read", { method: "GET", handler: listRecords, admin: true }],
  ["/api/db/write", { method: "POST", handler: writeRecord, admin: true }],
  ["/api/db/update", { method: "POST", handler: updateRecord, admin: true }],
  ["/api/db/delete", { method: "POST", handler: deleteRecord, admin: true }]
]);

const adminEnabled = (env) => typeof env.PWPCD_ADMIN_TOKEN === "string" && env.PWPCD_ADMIN_TOKEN.length >= 32;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/debug" || pathname.startsWith("/debug/")) {
      if (!adminEnabled(env)) return new Response("Página não encontrada.", { status: 404 });
      if (pathname === "/debug") return Response.redirect(new URL("/debug/", url), 308);
      if (pathname === "/debug/") url.pathname = "/debug/debug.html";
    }

    if (pathname !== "/api" && !pathname.startsWith("/api/")) {
      if (pathname === "/") url.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(url, request));
    }

    const route = routes.get(pathname);
    if (!route || (route.admin && !adminEnabled(env))) return json({ error: "Rota não encontrada." }, 404);
    if (request.method !== route.method) {
      return json({ error: "Método HTTP não permitido." }, 405, { Allow: route.method });
    }

    try {
      const origin = request.headers.get("Origin");
      if (request.method === "POST" && ((origin && origin !== url.origin)
        || request.headers.get("Sec-Fetch-Site") === "cross-site")) {
        throw new HttpError(403, "Origem da requisição inválida.");
      }
      if (route.admin) {
        const authorization = request.headers.get("Authorization") || "";
        if (!equal(Buffer.from(authorization), Buffer.from(`Bearer ${env.PWPCD_ADMIN_TOKEN}`))) {
          throw new HttpError(401, "Chave administrativa inválida.");
        }
      }
      const ip = request.headers.get("CF-Connecting-IP");
      if (route.throttle && ip && !(await env.AUTH_LIMIT.limit({ key: ip })).success) {
        return json({ error: "Muitas tentativas. Aguarde um minuto." }, 429, { "Retry-After": "60" });
      }
      return await route.handler(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("PWPCD", request.method, pathname, error.code || error.name);
      return json({ error: "Não foi possível concluir a operação. Tente novamente." }, 503);
    }
  }
};
