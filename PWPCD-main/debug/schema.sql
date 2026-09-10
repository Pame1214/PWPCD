CREATE TABLE IF NOT EXISTS debug_registros (
  id BIGSERIAL PRIMARY KEY,
  mensagem TEXT NOT NULL,
  origem TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash TEXT,
  legacy_password TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_users_one_password CHECK (password_hash IS NOT NULL OR legacy_password IS NOT NULL)
);

-- Sessões de login guardadas no banco (o Worker roda em várias instâncias,
-- então uma sessão em memória se perderia entre requisições).
CREATE TABLE IF NOT EXISTS app_sessions (
  token TEXT PRIMARY KEY,
  username VARCHAR(80) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Use o proprietário/admin para preparar a tabela de login.
GRANT USAGE ON SCHEMA public TO "PWPCD Acesso";
GRANT SELECT, INSERT ON TABLE app_users TO "PWPCD Acesso";
GRANT USAGE, SELECT ON SEQUENCE app_users_id_seq TO "PWPCD Acesso";
GRANT UPDATE (password_hash, legacy_password) ON TABLE app_users TO "PWPCD Acesso";
GRANT SELECT, INSERT ON TABLE debug_registros TO "PWPCD Acesso";
GRANT USAGE, SELECT ON SEQUENCE debug_registros_id_seq TO "PWPCD Acesso";
GRANT SELECT, INSERT, DELETE ON TABLE app_sessions TO "PWPCD Acesso";

-- Execute estes GRANTs com o usuário proprietário/admin do banco.
GRANT USAGE, CREATE ON SCHEMA public TO "ADM";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE debug_registros TO "ADM";
GRANT USAGE, SELECT ON SEQUENCE debug_registros_id_seq TO "ADM";
