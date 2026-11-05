// 平台脚本在 page.evaluate 里使用 innerText；TypeScript 的 Element 类型没有它，
// 但浏览器里的 HTMLElement 实际有。这里做最小声明，避免为了类型改抓取逻辑。
interface Element {
  innerText: string;
}
