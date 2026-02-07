# Default Workerd Configuration for MHNOS
# This is a basic template that can be customized per-process

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
  compatibilityFlags = ["nodejs_compat", "nodejs_als"],
  
  modules = [
    (name = "main", esModule = embed "worker.js"),
  ],
  
  bindings = [
    (name = "WORKSPACE", text = "/workspace"),
  ],
);
