const debugForm = document.querySelector("#debug-form");
const readButton = document.querySelector("#read-button");
const healthButton = document.querySelector("#health-button");
const tablesButton = document.querySelector("#tables-button");
const columnsButton = document.querySelector("#columns-button");
const mutationForm = document.querySelector("#mutation-form");
const deleteButton = document.querySelector("#delete-button");
const queryForm = document.querySelector("#query-form");
const neonSetupForm = document.querySelector("#neon-setup-form");
const statusElement = document.querySelector("#debug-status");
const outputElement = document.querySelector("#debug-output");
const API_BASE = String(window.PWPCD_API_BASE || "").replace(/\/$/, "");

const getSettings = () => {
  const table = document.querySelector("#table").value.trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error("O nome da tabela só pode conter letras, números e underscore.");
  }

  return { table };
};

const showResult = (message, data) => {
  statusElement.textContent = message;
  outputElement.textContent = JSON.stringify(data, null, 2);
};

const request = async (url, options = {}) => {
  let response;

  try {
    response = await fetch(`${API_BASE}${url}`, options);
  } catch {
    throw new Error("Não foi possível acessar a API. Verifique o endereço, o servidor local e as permissões de CORS.");
  }

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Faça login no Neon Auth antes de acessar o banco.");
    }

    if (response.status === 404) {
      throw new Error("Tabela não encontrada. Execute debug/schema.sql no SQL Editor do Neon e confirme o nome da tabela.");
    }

    const detail = data && typeof data === "object"
      ? data.error || data.upstream_body || JSON.stringify(data)
      : data || "A API não retornou detalhes.";
    throw new Error(`${response.status} ${response.statusText || ""}: ${detail}`.trim());
  }

  return data;
};

const readRecords = async () => {
  try {
    const { table } = getSettings();
    const data = await request(`/api/db/read?table=${encodeURIComponent(table)}`);
    showResult("Leitura concluída.", data);
  } catch (error) {
    showResult(`Erro na leitura: ${error.message}`, { error: error.message });
  }
};

const runGet = async (url, message) => {
  try {
    showResult(message, await request(url));
  } catch (error) {
    showResult(`Erro: ${error.message}`, { error: error.message });
  }
};

neonSetupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await request("/api/neon/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: document.querySelector("#project-id").value,
        branch: document.querySelector("#branch").value,
        roleName: document.querySelector("#role-name").value,
        databaseName: document.querySelector("#database-name").value
      })
    });
    showResult("Conexão configurada. Agora teste a conexão.", data);
  } catch (error) {
    showResult(`Erro na configuração: ${error.message}`, { error: error.message });
  }
});

healthButton.addEventListener("click", () => runGet("/api/db/health", "Conexão com o Neon concluída."));
tablesButton.addEventListener("click", () => runGet("/api/db/tables", "Tabelas encontradas."));
columnsButton.addEventListener("click", () => {
  try {
    const { table } = getSettings();
    runGet(`/api/db/columns?table=${encodeURIComponent(table)}`, "Colunas encontradas.");
  } catch (error) {
    showResult(`Erro: ${error.message}`, { error: error.message });
  }
});

debugForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const { table } = getSettings();
    const payload = JSON.parse(document.querySelector("#payload").value);
    const data = await request("/api/db/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, ...payload })
    });
    showResult("Gravação concluída.", data);
  } catch (error) {
    showResult(`Erro na gravação: ${error.message}`, { error: error.message });
  }
});

readButton.addEventListener("click", readRecords);

mutationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { table } = getSettings();
    const id = document.querySelector("#record-id").value;
    const values = JSON.parse(document.querySelector("#update-payload").value);
    showResult("Atualização concluída.", await request("/api/db/update", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ table, id, values })
    }));
  } catch (error) {
    showResult(`Erro na atualização: ${error.message}`, { error: error.message });
  }
});

deleteButton.addEventListener("click", async () => {
  try {
    const { table } = getSettings();
    const id = document.querySelector("#record-id").value;
    showResult("Exclusão concluída.", await request("/api/db/delete", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ table, id })
    }));
  } catch (error) {
    showResult(`Erro na exclusão: ${error.message}`, { error: error.message });
  }
});

queryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await request("/api/db/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: document.querySelector("#query").value })
    });
    showResult("Consulta concluída.", data);
  } catch (error) {
    showResult(`Erro na consulta: ${error.message}`, { error: error.message });
  }
});
