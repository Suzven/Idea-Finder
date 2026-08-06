import { BarChart3, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, Network, Puzzle, ShieldAlert, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteReviewProxyConfiguration, fetchKeywordSurferExtensionInfo, fetchReviewProxySettings, removeKeywordSurferExtension, saveReviewProxyConfiguration, testReviewProxyConfiguration, uploadKeywordSurferExtension } from "../api";
import { getOpenAIKey, saveOpenAIKey } from "../openaiSettings";
import { clearKeywordProviderSettings, getKeywordProviderSettings, saveKeywordProviderSettings } from "../keywordSettings";
import type { KeywordProviderSettings } from "../keywordSettings";
import type { KeywordSurferExtensionInfo, ReviewProxyTestResult } from "../shared/types";

interface ApiSettingsProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type SettingsTab = "openai" | "keywords" | "proxy";

const proxyStageLabels = {
  browser: "Chromium",
  proxy: "Прокси",
  request: "Запрос",
  response: "Ответ",
  cleanup: "Завершение",
} as const;

export function ApiSettings({ open, onClose, onSaved }: ApiSettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("openai");
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState(false);
  const [keywordSettings, setKeywordSettings] = useState<KeywordProviderSettings>(() => getKeywordProviderSettings());
  const [keywordSaved, setKeywordSaved] = useState(false);
  const [keywordError, setKeywordError] = useState("");
  const [surferInfo, setSurferInfo] = useState<KeywordSurferExtensionInfo>({ configured: false });
  const [surferLoading, setSurferLoading] = useState(false);
  const [surferUploading, setSurferUploading] = useState(false);
  const [surferError, setSurferError] = useState("");
  const [proxyServer, setProxyServer] = useState("");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [proxyBypass, setProxyBypass] = useState("");
  const [proxyPasswordVisible, setProxyPasswordVisible] = useState(false);
  const [proxyHasPassword, setProxyHasPassword] = useState(false);
  const [proxyConfigured, setProxyConfigured] = useState(false);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyMessage, setProxyMessage] = useState("");
  const [proxyError, setProxyError] = useState("");
  const [proxyTestResult, setProxyTestResult] = useState<ReviewProxyTestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(getOpenAIKey());
    setSaved(false);
    setVisible(false);
    setKeywordSettings(getKeywordProviderSettings());
    setKeywordSaved(false);
    setKeywordError("");
    setSurferError("");
    setSurferLoading(true);
    setProxyPassword("");
    setProxyPasswordVisible(false);
    setProxyMessage("");
    setProxyError("");
    setProxyLoading(true);
    let cancelled = false;
    void fetchReviewProxySettings()
      .then((settings) => {
        if (cancelled) return;
        setProxyServer(settings.server);
        setProxyUsername(settings.username);
        setProxyBypass(settings.bypass);
        setProxyHasPassword(settings.hasPassword);
        setProxyConfigured(settings.configured);
      })
      .catch((error) => {
        if (!cancelled) setProxyError(error instanceof Error ? error.message : "Не удалось загрузить настройки прокси.");
      })
      .finally(() => { if (!cancelled) setProxyLoading(false); });
    void fetchKeywordSurferExtensionInfo()
      .then((info) => { if (!cancelled) setSurferInfo(info); })
      .catch((error) => { if (!cancelled) setSurferError(error instanceof Error ? error.message : "Не удалось проверить расширение Keyword Surfer."); })
      .finally(() => { if (!cancelled) setSurferLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const persist = () => {
    saveOpenAIKey(value);
    setSaved(true);
    onSaved();
  };

  const clear = () => {
    saveOpenAIKey("");
    setValue("");
    setSaved(false);
    onSaved();
  };

  const persistKeywordSettings = () => {
    setKeywordError("");
    if (keywordSettings.googleAds.serviceAccountJson.trim()) {
      try {
        const parsed = JSON.parse(keywordSettings.googleAds.serviceAccountJson) as Record<string, unknown>;
        if (!parsed.client_email || !parsed.private_key) throw new Error();
      } catch {
        setKeywordError("JSON сервисного аккаунта Google должен содержать client_email и private_key.");
        return;
      }
    }
    saveKeywordProviderSettings(keywordSettings);
    setKeywordSaved(true);
    onSaved();
  };

  const clearKeywordSettings = () => {
    clearKeywordProviderSettings();
    setKeywordSettings(getKeywordProviderSettings());
    setKeywordSaved(false);
    setKeywordError("");
    onSaved();
  };

  const uploadSurfer = async (file?: File) => {
    if (!file) return;
    setSurferUploading(true);
    setSurferError("");
    try {
      setSurferInfo(await uploadKeywordSurferExtension(file));
      onSaved();
    } catch (error) {
      setSurferError(error instanceof Error ? error.message : "Не удалось загрузить ZIP Keyword Surfer.");
    } finally {
      setSurferUploading(false);
    }
  };

  const removeSurfer = async () => {
    setSurferUploading(true);
    setSurferError("");
    try {
      await removeKeywordSurferExtension();
      setSurferInfo({ configured: false });
      onSaved();
    } catch (error) {
      setSurferError(error instanceof Error ? error.message : "Не удалось удалить расширение Keyword Surfer.");
    } finally {
      setSurferUploading(false);
    }
  };

  const persistProxy = async () => {
    if (!proxyServer.trim()) return;
    setProxySaving(true);
    setProxyError("");
    setProxyMessage("");
    setProxyTestResult(null);
    try {
      const settings = await saveReviewProxyConfiguration({
        server: proxyServer.trim(),
        ...(proxyUsername.trim() ? { username: proxyUsername.trim() } : {}),
        ...(proxyPassword ? { password: proxyPassword } : {}),
        ...(proxyBypass.trim() ? { bypass: proxyBypass.trim() } : {}),
      });
      setProxyHasPassword(settings.hasPassword);
      setProxyConfigured(settings.configured);
      setProxyPassword("");
      setProxyMessage("Прокси сохранена в базе данных");
      onSaved();
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : "Не удалось сохранить прокси.");
    } finally {
      setProxySaving(false);
    }
  };

  const clearProxy = async () => {
    if (!window.confirm("Удалить сохранённую прокси?")) return;
    setProxySaving(true);
    setProxyError("");
    try {
      await deleteReviewProxyConfiguration();
      setProxyServer("");
      setProxyUsername("");
      setProxyPassword("");
      setProxyBypass("");
      setProxyHasPassword(false);
      setProxyConfigured(false);
      setProxyTestResult(null);
      setProxyMessage("Прокси удалена");
      onSaved();
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : "Не удалось удалить прокси.");
    } finally {
      setProxySaving(false);
    }
  };

  const testProxy = async () => {
    setProxyTesting(true);
    setProxyError("");
    setProxyMessage("");
    setProxyTestResult(null);
    try {
      const result = await testReviewProxyConfiguration();
      setProxyTestResult(result);
      if (result.ok) {
        setProxyMessage(`${result.message}${result.externalIp ? ` Внешний IP: ${result.externalIp}` : ""}`);
      } else {
        setProxyError(result.message);
      }
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : "Проверка прокси не удалась.");
    } finally {
      setProxyTesting(false);
    }
  };

  return (
    <div className={`settings-drawer api-settings-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="drawer-title">
        <div><span className="eyebrow"><Network size={14} /> CONNECTIONS</span><h2>Настройки</h2></div>
        <button onClick={onClose} aria-label="Закрыть"><X size={21} /></button>
      </div>

      <div className="api-settings-tabs" role="tablist" aria-label="Разделы настроек">
        <button type="button" role="tab" aria-selected={activeTab === "openai"} className={activeTab === "openai" ? "active" : ""} onClick={() => setActiveTab("openai")}><KeyRound size={17} />OpenAI</button>
        <button type="button" role="tab" aria-selected={activeTab === "keywords"} className={activeTab === "keywords" ? "active" : ""} onClick={() => setActiveTab("keywords")}><BarChart3 size={17} />Ключи</button>
        <button type="button" role="tab" aria-selected={activeTab === "proxy"} className={activeTab === "proxy" ? "active" : ""} onClick={() => setActiveTab("proxy")}><Network size={17} />Прокси</button>
      </div>

      {activeTab === "openai" && <div className="api-settings-pane" role="tabpanel">
        <div className="setting-block api-key-block">
          <span className="setting-label">OpenAI API key</span>
          <p>Ключ нужен только для запуска AI-аналитики коллекций.</p>
          <div className="api-key-input">
            <KeyRound size={18} />
            <input type={visible ? "text" : "password"} value={value} onChange={(event) => { setValue(event.target.value); setSaved(false); }} autoComplete="off" spellCheck={false} placeholder="sk-proj-…" />
            <button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? "Скрыть ключ" : "Показать ключ"}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
          </div>
          {saved && <div className="api-key-saved"><CheckCircle2 size={16} />Ключ сохранён в этом браузере</div>}
          <div className="api-key-actions">
            <button className="button primary grow" disabled={!value.trim()} onClick={persist}>Сохранить ключ</button>
            <button className="button danger-outline" disabled={!value} onClick={clear}><Trash2 size={16} />Удалить</button>
          </div>
        </div>
        <div className="api-key-warning"><ShieldAlert size={22} /><div><strong>Временный режим хранения</strong><p>Ключ хранится только в localStorage этого браузера. Во время анализа он передаётся вашему серверу по HTTPS для одного запроса к OpenAI и не сохраняется сервером.</p></div></div>
        <div className="setting-block api-model-note"><span className="setting-label">Модель</span><strong>GPT-5.6</strong><p>Vision-анализ креативов и полных скриншотов лендингов через Responses API.</p></div>
      </div>}

      {activeTab === "keywords" && <div className="api-settings-pane keyword-settings-pane" role="tabpanel">
        <div className="setting-block keyword-provider-block">
          <span className="setting-label">Google Ads Keyword Planner</span>
          <p>Официальные исторические метрики Google: средний месячный объём, CPC и конкуренция. Нужны developer token, рекламный customer ID и JSON сервисного аккаунта.</p>
          <div className="keyword-settings-fields">
            <label><span>Developer token</span><input value={keywordSettings.googleAds.developerToken} onChange={(event) => setKeywordSettings((current) => ({ ...current, googleAds: { ...current.googleAds, developerToken: event.target.value } }))} placeholder="22-значный токен Google Ads" autoComplete="off" spellCheck={false} /></label>
            <div className="keyword-settings-row">
              <label><span>Customer ID</span><input inputMode="numeric" value={keywordSettings.googleAds.customerId} onChange={(event) => setKeywordSettings((current) => ({ ...current, googleAds: { ...current.googleAds, customerId: event.target.value } }))} placeholder="123-456-7890" autoComplete="off" /></label>
              <label><span>Manager ID <small>необязательно</small></span><input inputMode="numeric" value={keywordSettings.googleAds.loginCustomerId} onChange={(event) => setKeywordSettings((current) => ({ ...current, googleAds: { ...current.googleAds, loginCustomerId: event.target.value } }))} placeholder="123-456-7890" autoComplete="off" /></label>
            </div>
            <label><span>Service account JSON</span><textarea value={keywordSettings.googleAds.serviceAccountJson} onChange={(event) => setKeywordSettings((current) => ({ ...current, googleAds: { ...current.googleAds, serviceAccountJson: event.target.value } }))} placeholder={'{\n  "client_email": "...",\n  "private_key": "..."\n}'} spellCheck={false} /></label>
          </div>
        </div>
        <div className="setting-block keyword-provider-block surfer-extension-settings">
          <span className="setting-label">Keyword Surfer для Chromium</span>
          <p>Загрузите ZIP папки версии расширения. Сервер распакует его в защищённую папку <code>~/.spyservice</code>, поэтому Git-деплой файл не удалит.</p>
          {surferLoading
            ? <div className="surfer-extension-state"><LoaderCircle className="spin" size={17} />Проверяем расширение…</div>
            : <div className={`surfer-extension-state ${surferInfo.configured ? "ready" : "missing"}`}><Puzzle size={18} /><div><strong>{surferInfo.configured ? `Keyword Surfer ${surferInfo.version ?? ""}` : "Расширение не загружено"}</strong><span>{surferInfo.configured ? "Готово к автоматическому сбору через Chromium" : "Нужен ZIP с manifest.json и файлами расширения"}</span></div></div>}
          <div className="surfer-extension-actions">
            <label className={`button primary ${surferUploading ? "disabled" : ""}`}><Upload size={15} />{surferUploading ? "Загружаем…" : surferInfo.configured ? "Обновить ZIP" : "Загрузить ZIP"}<input type="file" accept=".zip,application/zip" disabled={surferUploading} onChange={(event) => { void uploadSurfer(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
            <button type="button" className="button danger-outline" disabled={surferUploading || !surferInfo.configured} onClick={() => void removeSurfer()}><Trash2 size={15} />Удалить</button>
          </div>
          {surferError && <div className="proxy-settings-error">{surferError}</div>}
        </div>
        {keywordSaved && <div className="api-key-saved"><CheckCircle2 size={16} />Настройки источников сохранены в этом браузере</div>}
        {keywordError && <div className="proxy-settings-error">{keywordError}</div>}
        <div className="api-key-actions">
          <button className="button primary grow" onClick={persistKeywordSettings}>Сохранить источники</button>
          <button className="button danger-outline" onClick={clearKeywordSettings}><Trash2 size={16} />Очистить</button>
        </div>
        <div className="api-key-warning"><ShieldAlert size={22} /><div><strong>Реквизиты остаются в браузере</strong><p>Google-реквизиты сервер получает только во время конкретного запроса метрик и не пишет в MySQL или логи. Keyword Surfer работает через загруженное расширение Chromium; CSV остаётся резервным способом импорта.</p></div></div>
      </div>}

      {activeTab === "proxy" && <div className="api-settings-pane" role="tabpanel">
        <div className="setting-block review-proxy-block">
          <span className="setting-label">Прокси для сайтов с отзывами</span>
          <p>Chromium использует эту прокси только при сборе пользовательских отзывов. Проверка выполняется в фоне и не оборвётся из-за таймаута веб-сервера.</p>
          {proxyLoading
            ? <div className="proxy-settings-loading"><LoaderCircle className="spin" size={18} />Загружаем настройки…</div>
            : <div className="proxy-settings-fields">
              <label><span>Адрес прокси</span><input value={proxyServer} onChange={(event) => { setProxyServer(event.target.value); setProxyMessage(""); setProxyTestResult(null); }} placeholder="http://host:port или socks5://host:port" autoComplete="off" spellCheck={false} /></label>
              <label><span>Логин</span><input value={proxyUsername} onChange={(event) => setProxyUsername(event.target.value)} placeholder="Необязательно" autoComplete="off" spellCheck={false} /></label>
              <label><span>Пароль</span><div className="proxy-password-input"><input type={proxyPasswordVisible ? "text" : "password"} value={proxyPassword} onChange={(event) => setProxyPassword(event.target.value)} placeholder={proxyHasPassword ? "Пароль уже сохранён" : "Необязательно"} autoComplete="new-password" spellCheck={false} /><button type="button" onClick={() => setProxyPasswordVisible((current) => !current)} aria-label={proxyPasswordVisible ? "Скрыть пароль" : "Показать пароль"}>{proxyPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
              <label><span>Исключения</span><input value={proxyBypass} onChange={(event) => setProxyBypass(event.target.value)} placeholder="localhost,.mydomain.com" autoComplete="off" spellCheck={false} /></label>
            </div>}
          {proxyMessage && <div className="api-key-saved"><CheckCircle2 size={16} />{proxyMessage}</div>}
          {proxyError && <div className="proxy-settings-error">{proxyError}</div>}
          <div className="api-key-actions proxy-actions">
            <button className="button primary grow" disabled={proxyLoading || proxySaving || proxyTesting || !proxyServer.trim()} onClick={() => void persistProxy()}>{proxySaving ? <LoaderCircle className="spin" size={16} /> : <Network size={16} />}Сохранить</button>
            <button className="button ghost" disabled={proxyLoading || proxySaving || proxyTesting || !proxyConfigured} onClick={() => void testProxy()}>{proxyTesting ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}{proxyTesting ? "Проверяем…" : "Проверить"}</button>
            <button className="button danger-outline" disabled={proxyLoading || proxySaving || proxyTesting || !proxyConfigured} onClick={() => void clearProxy()}><Trash2 size={16} />Удалить</button>
          </div>
        </div>

        {proxyTestResult && <section className={`proxy-test-log ${proxyTestResult.ok ? "success" : "error"}`} aria-label="Лог проверки прокси">
          <div className="proxy-test-log-head">
            <div><span>Лог проверки</span><strong>{proxyTestResult.ok ? "Прокси работает" : "Проверка завершилась ошибкой"}</strong></div>
            <time>{proxyTestResult.elapsedMs} мс</time>
          </div>
          <div className="proxy-test-meta">
            {proxyTestResult.externalIp && <span><b>Внешний IP</b>{proxyTestResult.externalIp}</span>}
            {proxyTestResult.proxy && <span><b>Прокси</b>{proxyTestResult.proxy}</span>}
            {proxyTestResult.browserVersion && <span><b>Chromium</b>{proxyTestResult.browserVersion}</span>}
          </div>
          <div className="proxy-test-steps">
            {proxyTestResult.logs.map((log, index) => <article key={`${log.stage}-${index}`} className={log.status}>
              <i aria-hidden="true" />
              <div>
                <header><strong>{proxyStageLabels[log.stage]}</strong><time>+{log.elapsedMs} мс</time></header>
                <p>{log.message}</p>
                {log.details && <dl>{Object.entries(log.details).map(([key, detail]) => <div key={key}><dt>{key}</dt><dd>{String(detail)}</dd></div>)}</dl>}
              </div>
            </article>)}
          </div>
        </section>}

        <div className="api-key-warning proxy-security-note"><ShieldAlert size={22} /><div><strong>Пароль защищён</strong><p>Пароль прокси шифруется AES-256-GCM перед записью в MySQL и никогда не возвращается обратно в браузер или логи.</p></div></div>
      </div>}
    </div>
  );
}
