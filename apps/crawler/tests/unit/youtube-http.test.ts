import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findCommentsToken,
  parseCommentsCount,
  parseYouTubeListContent,
  parseYouTubeVideoDetail,
  textOf,
} from "../../src/platforms/youtube/http.ts";
import { normalizeExactPublishDate } from "../../src/platforms/youtube/parse.ts";

test("parseYouTubeListContent handles lockup, videoRenderer and shorts lockups", () => {
  const content = {
    richGridRenderer: {
      contents: [
        {
          richItemRenderer: {
            content: {
              lockupViewModel: {
                contentId: "vid1",
                contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
                metadata: {
                  lockupMetadataViewModel: {
                    title: { content: "第一条视频" },
                    metadata: {
                      contentMetadataViewModel: {
                        metadataRows: [{
                          metadataParts: [
                            { text: { content: "12K" }, accessibilityLabel: "12 thousand views" },
                            { text: { content: "7d ago" } },
                          ],
                        }],
                      },
                    },
                  },
                },
                contentImage: {
                  thumbnailViewModel: {
                    overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: "3:21" } }] } }],
                  },
                },
              },
            },
          },
        },
        {
          richItemRenderer: {
            content: {
              videoRenderer: {
                videoId: "vid2",
                title: { simpleText: "第二条视频" },
                viewCountText: { simpleText: "1,234 views" },
                publishedTimeText: { simpleText: "2 days ago" },
                lengthText: { simpleText: "10:01" },
              },
            },
          },
        },
        {
          richItemRenderer: {
            content: {
              shortsLockupViewModel: {
                entityId: "shorts-shelf-item-short1",
                accessibilityText: "短视频标题, 2.1 thousand views - play Short",
                onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: "short1" } } },
                overlayMetadata: {
                  primaryText: { content: "短视频标题" },
                  secondaryText: { content: "2.1K views" },
                },
              },
            },
          },
        },
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "TOKEN_1" } } } },
        { richItemRenderer: { content: { videoRenderer: { videoId: "vid1", title: { simpleText: "重复" } } } } },
      ],
    },
  };

  const parsed = parseYouTubeListContent(content);
  assert.equal(parsed.continuation, "TOKEN_1");
  assert.equal(parsed.items.length, 3, "按 videoId 去重");
  assert.deepEqual(parsed.items[0], {
    videoId: "vid1",
    title: "第一条视频",
    viewText: "12 thousand views",
    relativeText: "7d ago",
    duration: "3:21",
    isShort: false,
  });
  assert.equal(parsed.items[1].viewText, "1,234 views");
  assert.equal(parsed.items[1].relativeText, "2 days ago");
  assert.equal(parsed.items[2].videoId, "short1");
  assert.equal(parsed.items[2].isShort, true);
  assert.equal(parsed.items[2].title, "短视频标题");
});

test("parseYouTubeListContent keeps Chinese relative dates and view text", () => {
  const parsed = parseYouTubeListContent({
    richGridRenderer: {
      contents: [{
        richItemRenderer: {
          content: {
            videoRenderer: {
              videoId: "vid3",
              title: { simpleText: "中文标题" },
              viewCountText: { simpleText: "1.2万次观看" },
              publishedTimeText: { simpleText: "2天前" },
            },
          },
        },
      }],
    },
  });
  assert.equal(parsed.items[0].viewText, "1.2万次观看");
  assert.equal(parsed.items[0].relativeText, "2天前");
});

test("parseYouTubeVideoDetail prefers player data and default (not toggled) like button", () => {
  const player = {
    videoDetails: {
      title: "视频标题",
      author: "频道名",
      channelId: "UC123",
      lengthSeconds: "42",
      viewCount: "12345",
      isLiveContent: false,
    },
    microformat: {
      playerMicroformatRenderer: {
        title: { simpleText: "视频标题" },
        ownerChannelName: "频道名",
        externalChannelId: "UC123",
        lengthSeconds: "42",
        viewCount: 12345,
        likeCount: 0,
        publishDate: "2026-01-02T03:04:05-08:00",
        uploadDate: "2026-01-02T03:04:05-08:00",
        description: { simpleText: "完整描述" },
      },
    },
  };
  const next = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              {
                videoPrimaryInfoRenderer: {
                  title: { runs: [{ text: "视频标题" }] },
                  viewCount: { videoViewCountRenderer: { viewCount: { simpleText: "12,345 views" } } },
                  dateText: { simpleText: "Jan 2, 2026" },
                  videoActions: {
                    menuRenderer: {
                      topLevelButtons: [{
                        segmentedLikeDislikeButtonViewModel: {
                          likeButtonViewModel: {
                            likeButtonViewModel: {
                              toggleButtonViewModel: {
                                toggleButtonViewModel: {
                                  toggledButtonViewModel: {
                                    buttonViewModel: {
                                      accessibilityId: "id.video.like.button",
                                      title: "8",
                                      accessibilityText: "like this video along with 7 other people",
                                    },
                                  },
                                  defaultButtonViewModel: {
                                    buttonViewModel: {
                                      accessibilityId: "id.video.like.button",
                                      title: "7",
                                      accessibilityText: "like this video along with 7 other people",
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      }],
                    },
                  },
                },
              },
              { videoSecondaryInfoRenderer: { attributedDescription: { content: "next 里的描述" } } },
              {
                itemSectionRenderer: {
                  header: { commentsHeaderRenderer: {} },
                  contents: [{
                    continuationItemRenderer: {
                      continuationEndpoint: { continuationCommand: { token: "COMMENT_TOKEN" } },
                    },
                  }],
                },
              },
            ],
          },
        },
      },
    },
  };

  const detail = parseYouTubeVideoDetail(player, next, "vid1");
  assert.equal(detail.title, "视频标题");
  assert.equal(detail.channel, "频道名");
  assert.equal(detail.channelId, "UC123");
  assert.equal(detail.viewCount, "12345");
  assert.equal(detail.viewCountText, "12,345 views");
  assert.equal(detail.likeText, "7", "microformat likeCount 为 0 时用未点赞按钮的数字");
  assert.equal(detail.publishDate, "2026-01-02", "发布时间取 next 的 dateText，不取 player 的 publishDate");
  assert.equal(detail.description, "完整描述");
  assert.equal(detail.durationSeconds, "42");
  assert.equal(findCommentsToken(next), "COMMENT_TOKEN");
});

test("parseYouTubeVideoDetail falls back to next view text and accessibility likes", () => {
  const player = { videoDetails: { title: "T" }, microformat: { playerMicroformatRenderer: {} } };
  const next = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [{
              videoPrimaryInfoRenderer: {
                viewCount: { videoViewCountRenderer: { viewCount: { simpleText: "2.1万次观看" } } },
                videoActions: {
                  menuRenderer: {
                    topLevelButtons: [{
                      likeButtonViewModel: {
                        toggleButtonViewModel: {
                          defaultButtonViewModel: {
                            buttonViewModel: {
                              accessibilityId: "id.video.like.button",
                              title: "",
                              accessibilityText: "2.1万人赞过",
                            },
                          },
                        },
                      },
                    }],
                  },
                },
              },
            }],
          },
        },
      },
    },
  };
  const detail = parseYouTubeVideoDetail(player, next, "vid2");
  assert.equal(detail.viewCount, "21000");
  assert.equal(detail.likeText, "21000");
});

test("parseCommentsCount parses exact and localized counts", () => {
  const make = (text: string) => ({
    onResponseReceivedEndpoints: [{
      reloadContinuationItemsCommand: {
        continuationItems: [{ commentsHeaderRenderer: { countText: { runs: [{ text }] } } }],
      },
    }],
  });
  assert.equal(parseCommentsCount(make("2,461,395 Comments")), "2461395");
  assert.equal(parseCommentsCount(make("1.2万条评论")), "12000");
  assert.equal(parseCommentsCount({}), "");
});

test("findCommentsToken ignores unrelated continuation tokens", () => {
  const next = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [{
              itemSectionRenderer: {
                header: { commentsHeaderRenderer: {} },
                contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "COMMENTS" } } } }],
              },
            }],
          },
        },
      },
    },
    engagementPanels: [{
      engagementPanelSectionListRenderer: {
        content: { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "PANEL" } } } },
      },
    }],
  };
  assert.equal(findCommentsToken(next), "COMMENTS");
});

test("textOf reads content, simpleText, text and runs", () => {
  assert.equal(textOf({ content: "a" }), "a");
  assert.equal(textOf({ simpleText: "b" }), "b");
  assert.equal(textOf({ text: "c" }), "c");
  assert.equal(textOf({ runs: [{ text: "d" }, { text: "e" }] }), "de");
  assert.equal(textOf(null), "");
});

test("发布时间优先用 next.dateText，缺失时用 player microformat 兜底", () => {
  const player = {
    videoDetails: { title: "视频标题", viewCount: "4341" },
    microformat: { playerMicroformatRenderer: { publishDate: "2026-11-16T09:01:49-08:00", uploadDate: "2026-11-16T09:01:49-08:00" } },
  };
  const withDateText = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [{ videoPrimaryInfoRenderer: { dateText: { simpleText: "2026/11/16" }, relativeDateText: { simpleText: "3 日前" } } }],
          },
        },
      },
    },
  };
  const detail = parseYouTubeVideoDetail(player, withDateText, "htk-6sQn5eM");
  assert.equal(detail.publishDate, "2026-11-16");
  assert.equal(detail.uploadDate, "");
  assert.equal(detail.publishDateRaw?.pickedFrom, "videoPrimaryInfoRenderer.dateText");

  // 线上 BYDUAE/U30TpNZuNGQ：下一次响应里 dateText 缺失，但 player microformat 还在。
  // 这是精确时间，不能像以前那样丢掉后直接报错。
  const withoutDateText = {
    contents: { twoColumnWatchNextResults: { results: { results: { contents: [{ videoPrimaryInfoRenderer: {} }] } } } },
  };
  const fallback = parseYouTubeVideoDetail(player, withoutDateText, "U30TpNZuNGQ");
  assert.equal(fallback.publishDate, "2026-11-16T09:01:49-08:00", "dateText 缺失时退回 player microformat 的精确时间（原样保留，不换算时区）");
  assert.equal(fallback.publishDateRaw?.pickedFrom, "player.microformat.publishDate");
});

test("dateText、player microformat 都缺时，用描述面板的 publishDate", () => {
  const player = { videoDetails: { title: "视频标题" }, microformat: { playerMicroformatRenderer: {} } };
  const next = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [{ videoPrimaryInfoRenderer: { relativeDateText: { simpleText: "2 周前" } } }],
          },
        },
      },
    },
    engagementPanels: [{
      engagementPanelSectionListRenderer: {
        content: {
          structuredDescriptionContentRenderer: {
            items: [{ videoDescriptionHeaderRenderer: { publishDate: { simpleText: "2026年11月9日" } } }],
          },
        },
      },
    }],
  };
  const detail = parseYouTubeVideoDetail(player, next, "U30TpNZuNGQ");
  assert.equal(detail.publishDate, "2026-11-09");
  assert.equal(detail.publishDateRaw?.pickedFrom, "videoDescriptionHeaderRenderer.publishDate");
  assert.equal(detail.publishDateRaw?.dateText, "", "相对时间（2 周前）不参与取值");
});

test("新版 compositeVideoPrimaryInfoRenderer 里的主信息也能取到日期", () => {
  const next = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { videoSecondaryInfoRenderer: {} },
              {
                compositeVideoPrimaryInfoRenderer: {
                  compositeSourceVideoPrimaryInfoRenderers: [{
                    videoPrimaryInfoRenderer: {
                      title: { runs: [{ text: "视频标题" }] },
                      dateText: { simpleText: "2026年11月9日" },
                      viewCount: { videoViewCountRenderer: { viewCount: { simpleText: "47次观看" } } },
                    },
                  }],
                },
              },
            ],
          },
        },
      },
    },
  };
  const detail = parseYouTubeVideoDetail({ videoDetails: { title: "视频标题" } }, next, "U30TpNZuNGQ");
  assert.equal(detail.publishDate, "2026-11-09");
  assert.equal(detail.viewCountText, "47次观看");
});

test("所有精确日期来源都缺失时才留空，交给上层报错", () => {
  const detail = parseYouTubeVideoDetail(
    { videoDetails: { title: "视频标题" }, microformat: { playerMicroformatRenderer: {} } },
    { contents: { twoColumnWatchNextResults: { results: { results: { contents: [{ videoPrimaryInfoRenderer: { relativeDateText: { simpleText: "13d ago" } } }] } } } } },
    "U30TpNZuNGQ",
  );
  assert.equal(detail.publishDate, "");
  assert.equal(detail.publishDateRaw?.pickedFrom, "");
});

test("normalizeExactPublishDate 保留 ISO 时间、转换页面日期、拒绝相对时间", () => {
  assert.equal(normalizeExactPublishDate("2026-11-16T09:01:49-08:00"), "2026-11-16T09:01:49-08:00");
  assert.equal(normalizeExactPublishDate("2026-11-09"), "2026-11-09");
  assert.equal(normalizeExactPublishDate("2026年11月9日"), "2026-11-09");
  assert.equal(normalizeExactPublishDate("2026/11/09"), "2026-11-09");
  assert.equal(normalizeExactPublishDate("13d ago"), "");
  assert.equal(normalizeExactPublishDate("2 周前"), "");
  assert.equal(normalizeExactPublishDate(""), "");
});

test("assertPublishTime 对取不到发布时间的内容直接报错（不再静默跳过）", async () => {
  const { assertPublishTime } = await import("../../src/platforms/publish-time.ts");
  const args = {
    sinceTime: Date.parse("2026-08-21T00:00:00+08:00"),
    untilTime: Date.parse("2026-11-19T23:59:59+08:00"),
    rangeTimeZone: "Asia/Shanghai",
    limit: 0,
    commentTimeoutMs: 30000,
  };
  const ctx = (publishTime: unknown, extra: Record<string, unknown> = {}) => ({
    platform: "youtube", account: "BYD España", kind: "短视频", url: "https://www.youtube.com/shorts/x", publishTime, ...extra,
  });
  // 正常：有精确日期 / 只有日期 / 数字时间戳
  assertPublishTime(ctx("2026-11-19T06:21:23-08:00"));
  assertPublishTime(ctx("2026-11-19"));
  assertPublishTime(ctx(Date.parse("2026-11-19T00:00:00Z")));
  // 异常：拿不到时间 / 解析不了
  assert.throws(() => assertPublishTime(ctx("")), /取不到发布时间/);
  assert.throws(() => assertPublishTime(ctx("3 日前")), /取不到发布时间/);
  assert.throws(() => assertPublishTime(ctx(null)), /取不到发布时间/);
});
