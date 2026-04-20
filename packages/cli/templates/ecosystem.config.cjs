module.exports = {
  apps: [
    {
      name: "waifus-backend",
      cwd: "/ABSOLUTE/PROJECT/ROOT",
      script: "pnpm",
      args: "--filter backend start",
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "waifus-dashboard",
      cwd: "/ABSOLUTE/PROJECT/ROOT",
      script: "pnpm",
      args: "--filter dashboard start",
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: "3000"
      }
    }
  ]
};
