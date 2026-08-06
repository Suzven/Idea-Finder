import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { getMetaBrowser } from "./metaSnapshot.js";
import { createAuthenticatedSocks5Bridge, type SocksProxyBridge } from "./socksProxyBridge.js";

interface CapterraProxyCredentials {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

interface CapterraBrowserInfo {
  version: string;
  userAgent: string;
  proxy?: string;
  session?: string;
}

let capterraQueue = Promise.resolve();

async function acquireCapterraSlot(): Promise<() => void> {
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const previous = capterraQueue;
  capterraQueue = previous.then(() => current, () => current);
  await previous.catch(() => undefined);
  return releaseCurrent;
}

function resolveExecutablePath(): string {
  const executablePath = [
    config.metaChromiumExecutablePath,
    chromium.executablePath(),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!executablePath) {
    throw new AppError(
      503,
      "CAPTERRA_CHROMIUM_NOT_INSTALLED",
      "Для Capterra не найден Chromium.",
      "Установите Chromium через Playwright или задайте META_CHROMIUM_EXECUTABLE_PATH.",
    );
  }
  return executablePath;
}

function profileDirectory(proxySettings?: CapterraProxyCredentials): { path: string; reused: boolean } {
  const key = createHash("sha256")
    .update([
      proxySettings?.server ?? "direct",
      proxySettings?.username ?? "",
      proxySettings?.password ?? "",
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 20);
  const profileRoot = existsSync("/var/tmp") ? "/var/tmp" : tmpdir();
  const path = join(profileRoot, "spyservice-capterra-profiles", key);
  const reused = existsSync(join(path, "Default"));
  mkdirSync(path, { recursive: true });
  return { path, reused };
}

function proxyLabel(proxySettings?: CapterraProxyCredentials): string | undefined {
  if (!proxySettings?.server) return undefined;
  const parsed = new URL(proxySettings.server);
  parsed.username = "";
  parsed.password = "";
  return parsed.toString().replace(/\/$/, "");
}

export async function createCapterraBrowserContext(
  proxySettings?: CapterraProxyCredentials,
): Promise<{
  context: BrowserContext;
  browser: CapterraBrowserInfo;
  reusedProfile: boolean;
  close: () => Promise<void>;
}> {
  const releaseSlot = await acquireCapterraSlot();
  let bridge: SocksProxyBridge | undefined;
  try {
    const sharedBrowser = await getMetaBrowser();
    const rawVersion = sharedBrowser.version();
    const version = rawVersion.match(/\d+(?:\.\d+){1,3}/)?.[0] ?? rawVersion;
    const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
    const executablePath = resolveExecutablePath();
    const profile = profileDirectory(proxySettings);
    const proxyServer = proxySettings?.server;
    const needsSocksAuthBridge = Boolean(proxyServer?.toLowerCase().startsWith("socks5://") && (proxySettings?.username || proxySettings?.password));
    if (proxyServer && needsSocksAuthBridge) {
      bridge = await createAuthenticatedSocks5Bridge(proxyServer, proxySettings?.username, proxySettings?.password);
    }
    const proxy = proxyServer ? {
      server: bridge?.server ?? proxyServer,
      ...(!bridge && proxySettings?.username ? { username: proxySettings.username } : {}),
      ...(!bridge && proxySettings?.password ? { password: proxySettings.password } : {}),
      ...(proxySettings?.bypass ? { bypass: proxySettings.bypass } : {}),
    } : undefined;

    const context = await chromium.launchPersistentContext(profile.path, {
      headless: true,
      executablePath,
      viewport: { width: 1440, height: 1_000 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      locale: "en-US",
      timezoneId: "UTC",
      userAgent,
      ...(proxy ? { proxy } : {}),
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    const warmupPage = context.pages()[0] ?? await context.newPage();
    try {
      const response = await warmupPage.goto("https://www.capterra.com/", {
        waitUntil: "domcontentloaded",
        timeout: 35_000,
      });
      await warmupPage.waitForTimeout(800 + Math.floor(Math.random() * 350));
      console.info("[review-analysis:capterra-profile]", JSON.stringify({
        reusedProfile: profile.reused,
        httpStatus: response?.status(),
        finalUrl: warmupPage.url(),
      }));
    } catch (error) {
      console.info("[review-analysis:capterra-profile]", JSON.stringify({
        reusedProfile: profile.reused,
        warning: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      await warmupPage.close().catch(() => undefined);
    }

    let closed = false;
    return {
      context,
      browser: {
        version,
        userAgent,
        ...(proxyLabel(proxySettings) ? { proxy: proxyLabel(proxySettings) } : {}),
        session: profile.reused ? "постоянный профиль восстановлен" : "создан новый постоянный профиль",
      },
      reusedProfile: profile.reused,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await context.close();
        } finally {
          await bridge?.close();
          releaseSlot();
        }
      },
    };
  } catch (error) {
    await bridge?.close();
    releaseSlot();
    throw error;
  }
}
