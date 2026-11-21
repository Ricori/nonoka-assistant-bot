const path = require('path');

module.exports = {
  apps: [
    {
      name: 'nonoka-assistant-bot',
      script: path.join(__dirname, 'src/index.ts'),
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,

      // 进程守护
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      watch: false,

      // 日志
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/error.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: {
        NODE_ENV: 'production',
        ADMIN_HOST: '0.0.0.0',
        ADMIN_PORT: 9617,
        ADMIN_TOKEN: 'admintoken',
      },
    },
  ],
};
