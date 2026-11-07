import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findCommentsToken,
  parseCommentsCount,
  parseYouTubeListContent,
  parseYouTubeVideoDetail,
  textOf,
} from "../../src/platforms/youtube/http.ts";

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
  assert.equal(detail.publishDate, "2026-01-02T03:04:05-08:00");
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
