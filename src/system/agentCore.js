// src/system/agentCore.js
export async function runAgent({
  prompt,
  llm,
  fs,
  appDir,
  onLog
}) {
  const messages = [
    {
      role: "system",
      content:
        "You generate Vite-style React apps. " +
        "You may only create index.html, src/main.tsx, src/App.tsx, and src/styles.css. " +
        "Use CDN libraries only if explicitly needed."
    },
    { role: "user", content: prompt }
  ];

  let output = "";

  await llm({
    messages,
    onDelta(chunk) {
      output += chunk;
      onLog?.(chunk);
    }
  });

  // Expect fenced blocks
  const files = extractFiles(output);

  await fs.mkdir(appDir);
  await fs.mkdir(`${appDir}/src`);

  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(`${appDir}/${name}`, content);
  }

  return files;
}

function extractFiles(text) {
  const files = {};
  const regex = /```(html|css|tsx)\n([\s\S]*?)```/g;

  let match;
  while ((match = regex.exec(text))) {
    const ext = match[1];
    const body = match[2].trim();
    const name =
      ext === "html"
        ? "index.html"
        : ext === "css"
        ? "src/styles.css"
        : "tsx";

    if (name === "tsx") {
      files["src/main.tsx"] = files["src/main.tsx"] || body;
      if (files["src/main.tsx"] !== body) files["src/App.tsx"] = body;
    } else {
      files[name] = body;
    }
  }

  return files;
}
