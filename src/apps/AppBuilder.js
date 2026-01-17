// src/apps/AppBuilder.js
import { runAgent } from "../system/agentCore.js";
import { streamChat } from "../system/llmClient.js";
import * as fs from "../system/fs.js";

export const AppBuilderApp = {
  id: "appbuilder",
  title: "App Builder",

  launch() {
    const LAUNCHER_CONFIG_PATH = "/system/launcher.json";
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.height = "100%";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Describe the app you want to create…";
    textarea.style.flex = "0 0 120px";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.marginBottom = "8px";

    const button = document.createElement("button");
    button.textContent = "Generate App";

    const addButton = document.createElement("button");
    addButton.textContent = "Add to Launcher";
    addButton.disabled = true;

    const log = document.createElement("pre");
    log.style.flex = "1";
    log.style.overflow = "auto";

    const preview = document.createElement("iframe");
    preview.style.flex = "1";
    preview.style.border = "1px solid #444";

    actions.append(button, addButton);
    container.append(textarea, actions, log, preview);

    const toTitle = text =>
      text
        .split("-")
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

    const readText = async path => {
      const res = await fs.readFile(path, true);
      if (typeof res === "string") return res;
      if (res && res.success) return res.data;
      if (res && typeof res.data === "string") return res.data;
      return null;
    };

    const writeText = async (path, text) => {
      const res = await fs.writeFile(path, text);
      if (res && res.success === false) throw new Error(res.error || "Write failed");
    };

    const addToLauncher = async ({ slug, appDir, label }) => {
      const command = `oapp ${appDir}`;
      let config = { version: 2, items: [] };
      const existingText = await readText(LAUNCHER_CONFIG_PATH);
      if (existingText) {
        try {
          config = JSON.parse(existingText);
        } catch (e) {
          // fall back to fresh config
        }
      }

      if (!Array.isArray(config.items)) config.items = [];
      const item = {
        id: `app-${slug}`,
        label,
        type: "app",
        command,
        icon: "🧩"
      };
      const existing = config.items.find(
        entry => entry.id === item.id || entry.command === item.command
      );
      if (existing) Object.assign(existing, item);
      else config.items.push(item);
      if (!config.version || config.version < 2) config.version = 2;

      await writeText(LAUNCHER_CONFIG_PATH, JSON.stringify(config, null, 2));
    };

    let lastGenerated = null;

    button.onclick = async () => {
      log.textContent = "";
      const slug = textarea.value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "app";

      const appDir = `/apps/${slug}`;

      await runAgent({
        prompt: textarea.value,
        fs,
        appDir,
        llm: ({ messages, onDelta }) =>
          streamChat({
            provider: window.OS_LLM.provider,
            model: window.OS_LLM.model,
            apiKey: window.OS_LLM.apiKey,
            baseURL: window.OS_LLM.baseURL,
            messages,
            onDelta
          }),
        onLog: chunk => (log.textContent += chunk)
      });

      const html = await fs.readFile(`${appDir}/index.html`);
      const css = await fs.readFile(`${appDir}/styles.css`);
      const js = await fs.readFile(`${appDir}/app.js`);

      preview.srcdoc = `
        <style>${css}</style>
        ${html}
        <script>${js}<\/script>
      `;

      lastGenerated = {
        slug,
        appDir,
        label: toTitle(slug)
      };
      addButton.disabled = false;
    };

    addButton.onclick = async () => {
      if (!lastGenerated) return;
      try {
        await addToLauncher(lastGenerated);
        log.textContent += `\n[launcher] Added "${lastGenerated.label}"`;
      } catch (e) {
        log.textContent += `\n[launcher] Failed: ${e.message}`;
      }
    };

    WindowManager.createWindow("App Builder", container, {
      width: 800,
      height: 600
    });
  }
};
