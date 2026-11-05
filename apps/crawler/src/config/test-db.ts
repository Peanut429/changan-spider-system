/**
 * 测试库守卫：绝不允许测试/建表脚本指向生产库。
 */
export function getTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("缺少 TEST_DATABASE_URL");

  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL 不能和 DATABASE_URL 相同");
  }

  if (!/changan_rpa_test/.test(url)) {
    throw new Error(`TEST_DATABASE_URL 必须指向 changan_rpa_test：${url}`);
  }

  return url;
}
