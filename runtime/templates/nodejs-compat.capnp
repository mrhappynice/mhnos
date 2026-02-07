# Workerd Configuration with Full Node.js Compatibility
# Use this for running Node.js applications that need full compatibility

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
  ],
  
  sockets = [
    (
      name = "http",
      address = "127.0.0.1:0",
      http = (),
      service = "main"
    ),
  ]
);

const mainWorker :Workerd.Worker = (
  compatibilityDate = "2025-01-01",
  
  # Enable all Node.js compatibility flags
  compatibilityFlags = [
    "nodejs_compat",
    "nodejs_als",
    "nodejs_zlib",
    "nodejs_crypto",
    "nodejs_streams",
    "nodejs_timers",
    "nodejs_url",
    "nodejs_util",
    "nodejs_events",
    "nodejs_buffer",
    "nodejs_process",
    "nodejs_fs",
    "nodejs_net",
    "nodejs_http",
    "nodejs_https",
    "nodejs_tls",
    "nodejs_dgram",
    "nodejs_dns",
    "nodejs_os",
    "nodejs_path",
    "nodejs_querystring",
    "nodejs_stream",
    "nodejs_string_decoder",
    "nodejs_sys",
    "nodejs_timers",
    "nodejs_tty",
    "nodejs_url",
    "nodejs_util",
    "nodejs_v8",
    "nodejs_vm",
    "nodejs_zlib",
  ],
  
  modules = [
    (name = "main", esModule = embed "index.js"),
  ],
  
  bindings = [
    (name = "NODE_ENV", text = "production"),
    (name = "WORKSPACE", text = "/workspace"),
  ],
  
  # Limit memory per worker
  limits = (
    cpuMs = 30000,  # 30 seconds CPU time
    memoryMb = 1024, # 1GB memory
  ),
);
