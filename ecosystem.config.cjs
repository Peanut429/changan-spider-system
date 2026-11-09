/**
 * PM2 配置：单实例 fork，够用了。
 *
 * 服务器上（只放产物）：
 *   /srv/changan/web/.output/...        <- rsync 传上来
 *   /srv/changan/web/ecosystem.config.cjs
 *
 *   rsync -avz --delete apps/web/.output/ deploy@server:/srv/changan/web/
 *   cd /srv/changan/web && pm2 start ecosystem.config.cjs
 *   pm2 reload changan-web --update-env   # 改了配置或环境变量后
 *
 * 没有写 cwd：pm2 用执行命令时的当前目录，并在启动时解析成绝对路径存下来，
 * 所以必须在产物目录（.output 的父目录）下执行 pm2 start。
 *
 * 注意：Nitro 产物运行时不读 .env，DATABASE_URL 必须写在这里的 env 里，
 * 否则 /api/health 会直接返回 400「缺少 DATABASE_URL」。
 *
 * 文件名用 .cjs：仓库根 package.json 是 "type": "module"，.js 会被当成 ESM。
 */
module.exports = {
  apps: [
    {
      name: "changan-web",
      script: "server/index.mjs",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: 3010,
        DATABASE_URL:
          "postgres://ogilvy:1We^7Ma%tp@pgm-uf6bb4093trnp1hqbo.pg.rds.aliyuncs.com:5432/changan_social_data",
        DB_POOL_MAX: 10,
        SCRAPE_TIMEZONE: "Asia/Shanghai",
      },
    },
  ],
};
