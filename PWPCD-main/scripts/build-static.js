const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, ".cloudflare-static");

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const copyFile = (relativePath) => {
  const source = path.join(root, relativePath);
  const destination = path.join(output, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
};

[
  "index.html",
  "categorias.html",
  "header.html"
].forEach(copyFile);

["Css", "Js", "Defs"].forEach((directory) => {
  fs.cpSync(path.join(root, directory), path.join(output, directory), { recursive: true });
});

["debug/debug.html", "debug/debug.js"].forEach(copyFile);