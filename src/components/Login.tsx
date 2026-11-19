// Demo 站的簡易登入：只是擋一般瀏覽，不是真正的安全機制（密碼寫在前端，看原始碼就找得到）
// 用真正的 <form> 送出，瀏覽器會詢問是否記住密碼；登入後記在 localStorage，下次不用再輸入
import { useState, type ReactNode } from 'react';

const PASSWORD = 'haohan';
const KEY = 'demo-auth';

export function logout() {
  localStorage.removeItem(KEY);
  window.location.reload();
}

export default function Login({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(() => localStorage.getItem(KEY) === 'ok');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(false);
  if (ok) return <>{children}</>;
  return (
    <div className="login-bg">
      <form className="login" method="post" action="#"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw === PASSWORD) { localStorage.setItem(KEY, 'ok'); setOk(true); }
          else { setErr(true); setPw(''); }
        }}>
        <div className="login-brand"><div className="brand-mark">示</div><div><b>示範食品</b><span>經營決策平台 · Prototype</span></div></div>
        <h1>請輸入密碼</h1>
        <p>這是 demo 展示站，內容皆為模擬資料。</p>
        {/* 帳號欄位讓瀏覽器的密碼管理員能記住這組密碼 */}
        <input type="text" name="username" autoComplete="username" value="demo" readOnly hidden />
        <label htmlFor="pw">密碼</label>
        <input id="pw" name="password" type="password" autoComplete="current-password" autoFocus
          value={pw} onChange={(e) => { setPw(e.target.value); setErr(false); }} aria-invalid={err} />
        {err && <div className="login-err" role="alert">密碼不正確，請再試一次</div>}
        <button type="submit" className="primary" disabled={!pw}>進入</button>
      </form>
    </div>
  );
}
