/**
 * Bot server configuration from environment and CLI argv.
 * @param {string[]} [argv]
 */
export function loadConfig(argv = process.argv) {
  const config = {
    mc: {
      host: process.env.MC_HOST || 'localhost',
      port: parseInt(process.env.MC_PORT || '25565', 10),
      username: process.env.MC_USERNAME || 'HermesBot',
      auth: process.env.MC_AUTH || 'offline',
    },
    api: {
      port: parseInt(process.env.API_PORT || '3001', 10),
    },
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--port' && next) {
      config.api.port = parseInt(next, 10);
      i++;
    }
    if (arg === '--mc-host' && next) {
      config.mc.host = next;
      i++;
    }
    if (arg === '--mc-port' && next) {
      config.mc.port = parseInt(next, 10);
      i++;
    }
    if (arg === '--username' && next) {
      config.mc.username = next;
      i++;
    }
    if (arg === '--auth' && next) {
      config.mc.auth = next;
      i++;
    }
  }

  return config;
}
