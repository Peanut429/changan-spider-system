/**
 * 平台级致命错误：登录失效、浏览器不可用等。
 * runner 会先记录当前账号失败，然后终止整个平台，而不是继续用坏掉的页面抓下一个账号。
 */
export class FatalPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalPlatformError";
  }
}
