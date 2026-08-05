import { CheckCircle2, Eye, EyeOff, KeyRound, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getOpenAIKey, saveOpenAIKey } from "../openaiSettings";

interface ApiSettingsProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function ApiSettings({ open, onClose, onSaved }: ApiSettingsProps) {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(getOpenAIKey());
    setSaved(false);
    setVisible(false);
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

  return (
    <div className={`settings-drawer api-settings-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="drawer-title"><div><span className="eyebrow"><KeyRound size={13} /> AI CONNECTION</span><h2>Настройки OpenAI</h2></div><button onClick={onClose} aria-label="Закрыть"><X size={20} /></button></div>
      <div className="setting-block api-key-block">
        <span className="setting-label">OpenAI API key</span>
        <p>Ключ нужен только для запуска AI-аналитики коллекций.</p>
        <div className="api-key-input">
          <KeyRound size={17} />
          <input type={visible ? "text" : "password"} value={value} onChange={(event) => { setValue(event.target.value); setSaved(false); }} autoComplete="off" spellCheck={false} placeholder="sk-proj-…" />
          <button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? "Скрыть ключ" : "Показать ключ"}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
        </div>
        {saved && <div className="api-key-saved"><CheckCircle2 size={15} />Ключ сохранён в этом браузере</div>}
        <div className="api-key-actions">
          <button className="button primary grow" disabled={!value.trim()} onClick={persist}>Сохранить ключ</button>
          <button className="button danger-outline" disabled={!value} onClick={clear}><Trash2 size={15} />Удалить</button>
        </div>
      </div>
      <div className="api-key-warning"><ShieldAlert size={20} /><div><strong>Временный режим хранения</strong><p>Ключ хранится только в localStorage этого браузера. Во время анализа он передаётся вашему серверу по HTTPS и используется для одного запроса к OpenAI; сервер его не сохраняет. Для многопользовательского запуска позже лучше перенести ключ в серверный secret.</p></div></div>
      <div className="setting-block api-model-note"><span className="setting-label">Модель</span><strong>GPT-5.6</strong><p>Vision-анализ креативов и полных скриншотов лендингов через Responses API.</p></div>
    </div>
  );
}
