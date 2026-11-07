// YouTube 页面上的通用交互，供页面抓取和 HTTP 引导共用。
export async function autoAcceptYouTubeConsent(page): Promise<void> {
  for (const text of ["Accept all", "I agree", "全部接受", "接受全部"]) {
    const button = page.getByRole("button", { name: text, exact: true });
    if (await button.count().catch(() => 0)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(1000);
      return;
    }
  }
}
