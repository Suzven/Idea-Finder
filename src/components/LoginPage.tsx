import { Eye, EyeOff, LoaderCircle, LockKeyhole, LogIn, Sparkles, UserRound } from "lucide-react";
import { useState } from "react";
import { clearLegacyClientId, getLegacyClientId, login } from "../api";
import { clearKeywordProviderSettings, getKeywordProviderSettings } from "../keywordSettings";
import { getOpenAIKey, saveOpenAIKey } from "../openaiSettings";
import type { AuthUser, LegacyBrowserImport } from "../shared/types";

export function LoginPage({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    setError("");
    try {
      const googleAds = getKeywordProviderSettings().googleAds;
      const legacy: LegacyBrowserImport = {
        clientId: getLegacyClientId(),
        ...(getOpenAIKey() ? { openaiApiKey: getOpenAIKey() } : {}),
        ...(googleAds.developerToken || googleAds.serviceAccountJson ? { googleAds } : {}),
      };
      const session = await login(username.trim(), password, legacy);
      saveOpenAIKey("");
      clearKeywordProviderSettings();
      clearLegacyClientId();
      onAuthenticated(session.user);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Не удалось войти.");
    } finally {
      setLoading(false);
    }
  };

  return <main className="login-page">
    <section className="login-card">
      <div className="login-brand"><span><Sparkles size={24} /></span><div><strong>SpyService</strong><small>AD INTELLIGENCE</small></div></div>
      <header><h1>Вход в рабочее пространство</h1><p>Коллекции, аналитика и подключения будут доступны на всех ваших устройствах.</p></header>
      <form onSubmit={submit}>
        <label><span>Логин</span><div><UserRound size={18} /><input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></div></label>
        <label><span>Пароль</span><div><LockKeyhole size={18} /><input type={visible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /><button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? "Скрыть пароль" : "Показать пароль"}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
        {error && <p className="login-error">{error}</p>}
        <button className="button primary" disabled={loading || !username.trim() || !password}>{loading ? <LoaderCircle className="spin" size={18} /> : <LogIn size={18} />}{loading ? "Входим…" : "Войти"}</button>
      </form>
      <footer><LockKeyhole size={14} /> Сессия хранится в защищённой HttpOnly-cookie</footer>
    </section>
  </main>;
}

