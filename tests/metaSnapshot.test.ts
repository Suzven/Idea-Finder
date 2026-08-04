import { describe, expect, it } from "vitest";
import { extractMetaMediaFromHtml } from "../server/services/metaSnapshot.js";

describe("extractMetaMediaFromHtml", () => {
  it("prefers an HD video and returns its creative thumbnail", () => {
    const html = `
      <script type="application/json">
        {
          "image_url":"https:\\/\\/scontent-fra3-1.xx.fbcdn.net\\/avatar_p64x64.jpg",
          "thumbnail_url":"https:\\/\\/scontent-fra3-1.xx.fbcdn.net\\/creative.jpg?width=900\\u0026height=900",
          "playable_url_quality_hd":"https:\\/\\/video-fra3-1.xx.fbcdn.net\\/creative.mp4?token=abc\\u0026quality=hd"
        }
      </script>`;

    expect(extractMetaMediaFromHtml(html)).toEqual({
      mediaType: "video",
      mediaUrl: "https://video-fra3-1.xx.fbcdn.net/creative.mp4?token=abc&quality=hd",
      thumbnailUrl: "https://scontent-fra3-1.xx.fbcdn.net/creative.jpg?width=900&height=900",
    });
  });

  it("extracts the largest image from rendered snapshot markup", () => {
    const html = `
      <img width="48" height="48" src="https://scontent.xx.fbcdn.net/avatar_p48x48.jpg">
      <img width="1080" height="1080" src="https://scontent.xx.fbcdn.net/creative.jpg?asset=1&amp;size=large">`;

    expect(extractMetaMediaFromHtml(html)).toEqual({
      mediaType: "image",
      mediaUrl: "https://scontent.xx.fbcdn.net/creative.jpg?asset=1&size=large",
      thumbnailUrl: "https://scontent.xx.fbcdn.net/creative.jpg?asset=1&size=large",
    });
  });

  it("ignores media URLs outside Meta CDN domains", () => {
    expect(extractMetaMediaFromHtml('<img src="https://attacker.example/tracker.jpg">')).toBeUndefined();
  });

  it("selects the requested deeplink ad and extracts its page avatar", () => {
    const html = `
      {"ad_archive_id":"111","snapshot":{"original_image_url":"https:\\/\\/scontent.xx.fbcdn.net\\/wrong.jpg"}},
      "deeplink_ad_archive_result":{"deeplink_ad_archive":{
        "ad_archive_id":"222",
        "snapshot":{
          "page_profile_picture_url":"https:\\/\\/scontent.xx.fbcdn.net\\/page_s60x60.jpg",
          "display_format":"VIDEO",
          "videos":[{
            "video_hd_url":"https:\\/\\/video.xx.fbcdn.net\\/target.mp4",
            "video_preview_image_url":"https:\\/\\/scontent.xx.fbcdn.net\\/target-preview.jpg"
          }]
        }
      }}`;

    expect(extractMetaMediaFromHtml(html, "222")).toEqual({
      mediaType: "video",
      mediaUrl: "https://video.xx.fbcdn.net/target.mp4",
      thumbnailUrl: "https://scontent.xx.fbcdn.net/target-preview.jpg",
      advertiserAvatar: "https://scontent.xx.fbcdn.net/page_s60x60.jpg",
    });
  });
});
