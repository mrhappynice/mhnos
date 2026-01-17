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
        "You generate small HTML/CSS/JS site apps. " +
        "You may only create index.html, styles.css, and app.js. " +
        "Use CDN libraries only."
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

  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(`${appDir}/${name}`, content);
  }

  return files;
}

function extractFiles(text) {
  const files = {};
  const regex = /```(html|css|js)\n([\s\S]*?)```/g;

  let match;
  while ((match = regex.exec(text))) {
    const ext = match[1];
    const body = match[2].trim();
    const name =
      ext === "html"
        ? "index.html"
        : ext === "css"
        ? "styles.css"
        : "app.js";

    files[name] = body;
  }

  return files;
}
