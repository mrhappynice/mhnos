javascript:(async () => {
  const listDirectoryContents = async (directoryHandle, depth) => {
    depth = depth || 1;
    const entries = await directoryHandle.values();
    for await (const entry of entries) {
      const indentation = ' '.repeat(depth * 2);
      if (entry.kind === 'directory') {
        console.log(`${indentation}📁 ${entry.name}/`);
        await listDirectoryContents(entry, depth + 1);
      } else {
        console.log(`${indentation}📄 ${entry.name}`);
      }
    }
  };

  try {
    const opfsRoot = await navigator.storage.getDirectory();
    console.log("--- OPFS Contents for this Origin ---");
    await listDirectoryContents(opfsRoot);
    console.log("--- End of OPFS Contents ---");
  } catch (err) {
    console.error('Unable to access OPFS:', err);
    alert('Could not access the Origin Private File System. Ensure you are on a secure context (HTTPS/localhost).');
  }
})();
