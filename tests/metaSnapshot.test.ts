import { describe, expect, it } from "vitest";
import { buildMetaSnapshotRequestCandidates, extractMetaMediaFromHtml } from "../server/services/metaSnapshot.js";

describe("buildMetaSnapshotRequestCandidates", () => {
  it("falls back from the official snapshot URL to no-script and public library requests", () => {
    const candidates = buildMetaSnapshotRequestCandidates(
      "123",
      "https://www.facebook.com/ads/archive/render_ad/?id=123&access_token=snapshot-token",
      "snapshot-token",
    );

    expect(candidates.map(({ strategy }) => strategy)).toEqual([
      "ad_snapshot_url",
      "ad_snapshot_url_noscript",
      "public_ad_library",
    ]);
    expect(new URL(candidates[1].url).searchParams.get("_fb_noscript")).toBe("1");
    expect(new URL(candidates[2].url).searchParams.get("id")).toBe("123");
  });

  it("tries the current server token when the snapshot URL contains another token", () => {
    const candidates = buildMetaSnapshotRequestCandidates(
      "123",
      "https://www.facebook.com/ads/archive/render_ad/?id=123&access_token=old-token",
      "current-token",
    );

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ strategy: "current_token_noscript" }),
    ]));
    const currentTokenCandidate = candidates.find(({ strategy }) => strategy === "current_token_noscript");
    expect(new URL(currentTokenCandidate!.url).searchParams.get("access_token")).toBe("current-token");
  });
});

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

  it("records detailed candidate diagnostics for preview troubleshooting", () => {
    const diagnostics: Array<{ stage: string; [key: string]: unknown }> = [];
    const result = extractMetaMediaFromHtml(
      '<img src="https://attacker.example/tracker.jpg"><img width="1080" height="1080" src="https://scontent.xx.fbcdn.net/creative.jpg">',
      undefined,
      diagnostics,
    );

    expect(result?.mediaUrl).toBe("https://scontent.xx.fbcdn.net/creative.jpg");
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "target_ad", targetFound: true }),
      expect.objectContaining({ stage: "candidate_rejected", reason: "invalid_or_non_meta_url" }),
      expect.objectContaining({ stage: "candidate_accepted", kind: "image" }),
      expect.objectContaining({ stage: "candidate_selection", imageCandidates: 1 }),
    ]));
  });

  it("extracts creative, page avatar and unwrapped destination from rendered ad_snapshot_url DOM", () => {
    const html = `
      <div>ID Библиотеки: 1006049118713192</div>
      <img alt="Romantic&amp;Love" class="_8nqq img"
        src="https://scontent-iev1-1.xx.fbcdn.net/avatar.jpg?stp=dst-jpg_s60x60_tt6&amp;asset=avatar">
      <a target="_blank" href="https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2Foffer%3Fx%3D1&amp;h=signature">
        <img alt="" src="https://scontent-iev1-1.xx.fbcdn.net/creative.jpg?stp=dst-jpg_s600x600_tt6&amp;asset=creative">
      </a>`;

    expect(extractMetaMediaFromHtml(html, "1006049118713192")).toEqual({
      mediaType: "image",
      mediaUrl: "https://scontent-iev1-1.xx.fbcdn.net/creative.jpg?stp=dst-jpg_s600x600_tt6&asset=creative",
      thumbnailUrl: "https://scontent-iev1-1.xx.fbcdn.net/creative.jpg?stp=dst-jpg_s600x600_tt6&asset=creative",
      advertiserAvatar: "https://scontent-iev1-1.xx.fbcdn.net/avatar.jpg?stp=dst-jpg_s60x60_tt6&asset=avatar",
      landingUrl: "https://shop.example/offer?x=1",
    });
  });

  it("extracts video source and poster from rendered snapshot markup", () => {
    const html = `
      <div>ID Библиотеки: 222</div>
      <video poster="https://scontent.xx.fbcdn.net/video-poster.jpg">
        <source src="https://video.xx.fbcdn.net/creative.mp4" type="video/mp4">
      </video>`;

    expect(extractMetaMediaFromHtml(html, "222")).toEqual({
      mediaType: "video",
      mediaUrl: "https://video.xx.fbcdn.net/creative.mp4",
      thumbnailUrl: "https://scontent.xx.fbcdn.net/video-poster.jpg",
    });
  });
});
