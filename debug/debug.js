(() => {
  const form = document.querySelector("#debug-form");
  const tokenInput = document.querySelector("#admin-token");
  const idInput = document.querySelector("#record-id");
  const status = document.querySelector("#debug-status");
  const output = document.querySelector("#debug-output");
  let busy = false;

  const run = async (path, message, body) => {
    if (busy) return;
    busy = true;
    status.textContent = "Aguarde...";
    output.textContent = "";

    try {
      const headers = {};
      if (path.startsWith("/api/db/")) {
        const token = tokenInput.value.trim();
        if (!token) {
          tokenInput.focus();
          throw new Error("Informe a chave administrativa.");
        }
        headers.Authorization = `Bearer ${token}`;
      }
      const options = { headers };
      if (body) {
        headers["Content-Type"] = "application/json";
        options.method = "POST";
        options.body = JSON.stringify(body);
      }
      const response = await fetch(path, options);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível concluir a operação.");
      status.textContent = message;
      output.textContent = JSON.stringify(result, null, 2);
      return result;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
    }
  };

  const hasRecordId = () => {
    if (idInput.value.trim() && idInput.checkValidity()) return true;
    status.textContent = "Informe o ID do registro.";
    idInput.focus();
    return false;
  };

  document.querySelector("#health-button").addEventListener("click", () => {
    void run("/api/health", "Conexão com o PostgreSQL verificada.");
  });
  document.querySelector("#read-button").addEventListener("click", () => {
    void run("/api/db/read", "Leitura concluída.");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const update = event.submitter?.value === "update";
    if (update && !hasRecordId()) return;
    const result = await run(
      update ? "/api/db/update" : "/api/db/write",
      update ? "Registro atualizado." : "Registro gravado.",
      {
        id: idInput.value.trim(),
        mensagem: document.querySelector("#message").value,
        origem: document.querySelector("#origin").value
      }
    );
    if (result?.record) idInput.value = result.record.id;
  });

  document.querySelector("#delete-button").addEventListener("click", async () => {
    if (busy || !hasRecordId()) return;
    const id = idInput.value.trim();
    if (!window.confirm(`Excluir o registro ${id}?`)) return;
    const result = await run("/api/db/delete", "Registro excluído.", { id });
    if (result?.ok) idInput.value = "";
  });
})();
