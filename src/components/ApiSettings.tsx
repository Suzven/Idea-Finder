import { CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, Network, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteReviewProxyConfiguration, fetchReviewProxySettings, saveReviewProxyConfiguration, testReviewProxyConfiguration } from "../api";
import { getOpenAIKey, saveOpenAIKey } from "../openaiSettings";
import type { ReviewProxyTestResult } from "../shared/types";

interface ApiSettingsProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type SettingsTab = "openai" | "proxy";

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

      {activeTab === "proxy" && <div className="api-settings-pane" role="tabpanel">
        <div className="setting-block review-proxy-block">
          <span className="setting-label">Прокси для Trustpilot и Capterra</span>
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
