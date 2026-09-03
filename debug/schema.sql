CREATE TABLE IF NOT EXISTS debug_registros (
  id BIGSERIAL PRIMARY KEY,
  mensagem TEXT NOT NULL,
  origem TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Execute estes GRANTs com o usuário proprietário/admin do banco.
GRANT USAGE, CREATE ON SCHEMA public TO "ADM";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE debug_registros TO "ADM";
GRANT USAGE, SELECT ON SEQUENCE debug_registros_id_seq TO "ADM";
