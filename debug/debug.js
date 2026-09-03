const debugForm = document.querySelector("#debug-form");
const readButton = document.querySelector("#read-button");
const statusElement = document.querySelector("#debug-status");
const outputElement = document.querySelector("#debug-output");

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
    response = await fetch(url, options);
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

    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(data)}`);
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
