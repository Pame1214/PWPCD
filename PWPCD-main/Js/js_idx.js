const categorias = [
  {
    nome: "Deficiência física",
    subdeficiencias: ["Mobilidade reduzida", "Paraplegia", "Tetraplegia"]
  },
  {
    nome: "Deficiência mental",
    subdeficiencias: [
      "Deficiência intelectual",
      "Transtornos do desenvolvimento"
    ]
  }
];

const container = document.querySelector("#categorias");
const headerContainer = document.querySelector("#site-header");
const sidePanel = document.querySelector(".side-panel");
const panelToggle = document.querySelector(".panel-toggle");
const loginForm = document.querySelector("#login-form");
const loginStatus = document.querySelector("#login-status");
const registerForm = document.querySelector("#register-form");
const registerStatus = document.querySelector("#register-status");
const recordForm = document.querySelector("#record-form");
const recordStatus = document.querySelector("#record-status");
const API_BASE = String(window.PWPCD_API_BASE || "").replace(/\/$/, "");

const apiFetch = (path, options) => fetch(`${API_BASE}${path}`, options);

const applyTheme = (theme, themeToggle = null) => {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);

  if (themeToggle) {
    themeToggle.checked = theme === "dark";
  }
};

const initTheme = () => {
  const themeToggle = document.querySelector("#themeToggle");
  const savedTheme = localStorage.getItem("theme");
  const initialTheme = savedTheme || "light";

  applyTheme(initialTheme, themeToggle);

  themeToggle?.addEventListener("change", (event) => {
    const nextTheme = event.target.checked ? "dark" : "light";
    applyTheme(nextTheme, event.target);
  });
};

const initHeaderLinks = () => {
  const isNestedPage = /\/(Defs|debug)\//.test(window.location.pathname);
  document.querySelectorAll(".header-link[data-root-path]").forEach((link) => {
    const rootPath = link.dataset.rootPath;
    link.href = isNestedPage ? `../${rootPath}` : rootPath;
  });
};

const initUserControls = async () => {
  try {
    const response = await apiFetch("/api/session");
    const data = await response.json();
    if (!data.authenticated || !data.username) return;
    const headerUser = document.createElement("span");
    headerUser.className = "user-display";
    headerUser.textContent = `Conectado como ${data.username}`;
    document.querySelector(".theme-toggle-wrap")?.append(headerUser);

    const sidebarUser = document.createElement("div");
    sidebarUser.className = "sidebar-user";
    sidebarUser.innerHTML = `<span class="sidebar-user__name"></span>`;
    sidebarUser.querySelector(".sidebar-user__name").textContent = data.username;
    document.querySelector(".side-panel__nav")?.before(sidebarUser);
  } catch {
    return;
  }
};

const initSidebar = () => {
  if (!sidePanel || !panelToggle) return;

  panelToggle.addEventListener("click", () => {
    const isCollapsed = sidePanel.classList.toggle("is-collapsed");
    panelToggle.setAttribute("aria-expanded", String(!isCollapsed));
    panelToggle.setAttribute("aria-label", isCollapsed ? "Abrir menu lateral" : "Fechar menu lateral");
  });
};

const initLogin = () => {
  if (!loginForm || !loginStatus) return;

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = loginForm.querySelector("button[type=submit]");
    submitButton.disabled = true;
    loginStatus.textContent = "Entrando...";

    try {
      const response = await apiFetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.querySelector("#email").value,
          password_hash: await hashPassword(document.querySelector("#senha").value)
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Login recusado pelo Neon Auth.");
      window.location.href = "categorias.html";
    } catch (error) {
      loginStatus.textContent = `Erro no login: ${error.message}`;
    } finally {
      submitButton.disabled = false;
    }
  });
};

const hashPassword = async (password) => {
  const bytes = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const initRegister = () => {
  if (!registerForm || !registerStatus) return;
  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const response = await apiFetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.querySelector("#register-username").value,
          password_hash: await hashPassword(document.querySelector("#register-password").value)
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Não foi possível registrar.");
      window.location.href = "categorias.html";
    } catch (error) {
      registerStatus.textContent = `Erro no cadastro: ${error.message}`;
    }
  });
};

const initRecordForm = () => {
  if (!recordForm || !recordStatus) return;

  recordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = recordForm.querySelector("button[type=submit]");
    submitButton.disabled = true;
    recordStatus.textContent = "Salvando...";

    try {
      const response = await apiFetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mensagem: document.querySelector("#record-message").value,
          origem: document.querySelector("#record-origin").value
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Não foi possível salvar o registro.");
      recordStatus.textContent = `Registro ${data.record.id} salvo com sucesso.`;
      recordForm.reset();
      document.querySelector("#record-origin").value = "site";
    } catch (error) {
      recordStatus.textContent = `Erro ao salvar: ${error.message}`;
    } finally {
      submitButton.disabled = false;
    }
  });
};

const renderHeader = async () => {
  if (!headerContainer) return;

  try {
    const isNestedPage = /\/(Defs|debug)\//.test(window.location.pathname);
    const headerPath = isNestedPage ? "../header.html" : "header.html";
    const response = await fetch(headerPath);

    if (!response.ok) {
      throw new Error("Falha ao carregar o cabeçalho");
    }

    headerContainer.innerHTML = await response.text();
  } catch (error) {
    console.error(error);
    headerContainer.innerHTML = `
      <div class="header-content">
        <h1>Website para pessoas com deficiência</h1>
        <p>Informações sobre pessoas com deficiência</p>
      </div>
    `;
  }

  initHeaderLinks();
  initTheme();
};

renderHeader().then(initUserControls);
initSidebar();
initLogin();
initRegister();
initRecordForm();

if (container) categorias.forEach((categoria) => {
  const elemento = document.createElement("details");
  elemento.className = "categoria";

  elemento.innerHTML = `
    <summary>${categoria.nome}</summary>
    <ul class="subdeficiencias">
      ${categoria.subdeficiencias
        .map((item) => {
          const paginas = {
            "Mobilidade reduzida": "Defs/mobred.html",
            Paraplegia: "Defs/paraplegia.html",
            Tetraplegia: "Defs/tetraplegia.html",
            "Deficiência intelectual": "Defs/deficiencia-intelectual.html",
            "Transtornos do desenvolvimento": "Defs/transtornos-desenvolvimento.html"
          };
          const pagina = paginas[item] || null;
          return `<li>${pagina ? `<a href="${pagina}">${item}</a>` : item}</li>`;
        })
        .join("")}
    </ul>
  `;

  const lista = elemento.querySelector(".subdeficiencias");
  lista.style.overflow = "hidden";
  lista.style.maxHeight = "0px";
  lista.style.opacity = "0";
  lista.style.transform = "translateY(-4px)";
  lista.style.transition = "max-height 260ms ease, opacity 220ms ease, transform 220ms ease";

  elemento.addEventListener("toggle", () => {
    if (elemento.open) {
      lista.style.maxHeight = `${lista.scrollHeight}px`;
      lista.style.opacity = "1";
      lista.style.transform = "translateY(0)";
      return;
    }

    lista.style.maxHeight = `${lista.scrollHeight}px`;
    requestAnimationFrame(() => {
      lista.style.maxHeight = "0px";
      lista.style.opacity = "0";
      lista.style.transform = "translateY(-4px)";
    });
  });

  container.appendChild(elemento);
});