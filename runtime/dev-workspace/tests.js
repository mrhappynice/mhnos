console.log("Hello from external runtime!");
  console.log("Node version:", process.version);
  console.log("Working directory:", process.cwd());
  setTimeout(() => console.log("Done!"), 1000);