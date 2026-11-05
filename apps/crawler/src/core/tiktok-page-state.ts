type TikTokPageStateInput = {
  title: string;
  body: string;
  attrs: string;
  visibleButtons: string[];
  hasContentLinks: boolean;
  hasUserDetail: boolean;
  hasCaptchaModal?: boolean;
  url: string;
};

export function classifyTikTokPageState(input: TikTokPageStateInput) {
  const lowerIncludes = (value, patterns) => {
    const text = String(value || "").toLowerCase();
    return patterns.some((pattern) => text.includes(pattern));
  };
  const textHaystack = `${input.title}\n${input.body}`;
  const hasCaptchaModal = Boolean(input.hasCaptchaModal)
    || input.visibleButtons.some((text) => /captcha_close_button/i.test(text))
    || /Drag the slider to fit the puzzle/i.test(input.body);
  const hasChallengeText = [
    /complete (the )?verification/i,
    /verification (is )?required/i,
    /verify (to|you|that|your)/i,
    /security check/i,
    /not a robot/i,
    /captcha/i,
    /unusual traffic/i,
    /too many attempts/i,
    /请完成.*验证/,
    /完成.*验证/,
    /安全验证/,
    /人机验证/,
    /验证码/,
    /拖动.*滑块/,
    /滑块验证/,
    /拼图验证/,
    /访问.*频繁/,
  ].some((pattern) => pattern.test(textHaystack));
  const hasChallengeElement = lowerIncludes(input.attrs, [
    "captcha",
    "challenge",
    "verification",
    "verifycenter",
    "secsdk-captcha",
    "security_check",
  ]);
  const url = new URL(input.url);
  const challengeUrl = /captcha|challenge|verification|verify/i.test(`${url.hostname}${url.pathname}`);
  const hasRefreshButton = input.visibleButtons.some((text) => /\bRefresh\b/i.test(text) || /刷新/.test(text));
  const hasRecoverableError = hasRefreshButton;
  const isHumanVerification = Boolean(
    challengeUrl
    || hasCaptchaModal
    || ((hasChallengeText || hasChallengeElement) && !input.hasContentLinks && !input.hasUserDetail)
  );
  return {
    hasCaptchaModal,
    hasChallengeText,
    hasChallengeElement,
    hasRecoverableError,
    hasRefreshButton,
    isHumanVerification,
    needsRecovery: isHumanVerification || hasRecoverableError,
  };
}

export function shouldRestartTikTokAccountScrape(recoveryState) {
  return Boolean(recoveryState?.clickedRefresh);
}
