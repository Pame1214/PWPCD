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

const initSidebar = () => {
  if (!sidePanel || !panelToggle) return;

  panelToggle.addEventListener("click", () => {
    const isCollapsed = sidePanel.classList.toggle("is-collapsed");
    panelToggle.setAttribute("aria-expanded", String(!isCollapsed));
    panelToggle.setAttribute("aria-label", isCollapsed ? "Abrir menu lateral" : "Fechar menu lateral");
  });
};

const renderHeader = async () => {
  if (!headerContainer) return;

  try {
    const response = await fetch("header.html");

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

  initTheme();
};

renderHeader();
initSidebar();

categorias.forEach((categoria) => {
  const elemento = document.createElement("details");
  elemento.className = "categoria";

  elemento.innerHTML = `
    <summary>${categoria.nome}</summary>
    <ul class="subdeficiencias">
      ${categoria.subdeficiencias
        .map((item) => `<li>${item}</li>`)
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