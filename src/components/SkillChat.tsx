// 共用的對話畫面：左側對話紀錄、右側對話；每個 skill 只要提供邏輯（ChatSkill）和結果卡（Card）
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useApp } from '../context/AppContext';
import { Modal } from './ui';
import { detectSkill, SKILLS } from '../skills/router';
import type { ChatReply, ChatSkill, SkillContext } from '../skills/types';

type Msg<R> = { id: number; role: 'user'; text: string } | ({ id: number; role: 'assistant' } & ChatReply<R>);
interface Session<S, R> { id: number; title: string; msgs: Msg<R>[]; state: S; at: string }

// 切換分頁再回來時保留對話紀錄（demo：存在記憶體，重新整理會清掉）
const CACHE = new Map<string, { sessions: unknown[]; curId: number; seq: number }>();

export default function SkillChat<S, R>({ skill, Card, seeds = [] }: {
  skill: ChatSkill<S, R>;
  Card: ComponentType<{ r: R }>;
  seeds?: { text: string; at: string }[];
}) {
  const { order, model, route, navigate } = useApp();
  const ctx: SkillContext = useMemo(() => ({ om: order!, model }), [order, model]);
  const examples = useMemo(() => skill.examples(ctx), [skill, ctx]);
  const cached = CACHE.get(skill.def.id);
  const seq = useRef(cached?.seq ?? 1);

  const greeting = (): Msg<R> => ({ id: seq.current++, role: 'assistant', trace: [], text: [skill.greeting], chips: examples });
  const titleOf = (st: S, first?: string) => skill.title(st, ctx) ?? (first ? first.slice(0, 16) : '新對話');
  const fresh = (): Session<S, R> => ({ id: seq.current++, title: '新對話', msgs: [greeting()], state: skill.empty(), at: '剛剛' });

  const [sessions, setSessions] = useState<Session<S, R>[]>(() => {
    if (cached) return cached.sessions as Session<S, R>[];
    // demo：先放幾段過去的對話（真的跑過計算），示意對話紀錄
    const past = seeds.map(({ text, at }) => {
      const r = skill.run(text, skill.empty(), ctx);
      return { id: seq.current++, at, state: r.state, title: titleOf(r.state, text),
        msgs: [greeting(), { id: seq.current++, role: 'user', text }, { id: seq.current++, role: 'assistant', ...r.reply, chips: undefined }] } as Session<S, R>;
    });
    return [fresh(), ...past];
  });
  const [curId, setCurId] = useState(() => cached?.curId ?? sessions[0].id);
  const cur = sessions.find((x) => x.id === curId) ?? sessions[0];
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showMethod, setShowMethod] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const handledQ = useRef(false);

  useEffect(() => { CACHE.set(skill.def.id, { sessions, curId, seq: seq.current }); }, [sessions, curId, skill.def.id]);

  // 卡片高度 ＝ 視窗高度 − 卡片上緣位置 − 底部留白，讓輸入列一直貼在畫面底部
  useLayoutEffect(() => {
    const fit = () => {
      const el = rootRef.current; if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty('--chat-top', `${Math.round(top + 64)}px`);
    };
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => { threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' }); }, [cur.msgs.length, busy, curId]);

  const patch = (id: number, f: (s: Session<S, R>) => Session<S, R>) => setSessions((all) => all.map((x) => (x.id === id ? f(x) : x)));

  const send = (text: string, target?: Session<S, R>) => {
    const t = text.trim();
    if (!t || busy) return;
    const s0 = target ?? cur;
    const sid = s0.id; const st = s0.state;
    patch(sid, (x) => ({ ...x, msgs: [...x.msgs, { id: seq.current++, role: 'user', text: t }] }));
    setInput('');
    setBusy(true);
    // 模擬模型思考的時間；計算本身是即時的
    window.setTimeout(() => {
      const hits = detectSkill(t, ctx);
      const other = hits.length && !hits.includes(skill.def.id) ? SKILLS.find((x) => x.id === hits[0]) : undefined;
      if (other) {
        const reply: ChatReply<R> = other.enabled
          ? { text: [`這看起來是「${other.name}」的問題（${other.description}）。這裡是「${skill.def.name}」，要切換過去問嗎？`],
              trace: [`分流：判斷屬於「${other.name}」skill，不是目前的「${skill.def.name}」`], switchTo: { skill: other.id, name: other.name, text: t } }
          : { text: [`這是「${other.name}」的問題（${other.description}）。這個情境還沒開放。`], trace: [`分流：判斷屬於「${other.name}」skill → 尚未開放，不回答`] };
        patch(sid, (x) => ({ ...x, at: '剛剛', msgs: [...x.msgs, { id: seq.current++, role: 'assistant', ...reply }] }));
      } else {
        const { reply, state } = skill.run(t, st, ctx);
        patch(sid, (x) => ({ ...x, state, at: '剛剛',
          title: titleOf(state, x.msgs.find((m) => m.role === 'user')?.text ?? t),
          msgs: [...x.msgs, { id: seq.current++, role: 'assistant', ...reply }] }));
      }
      setBusy(false);
    }, 650);
  };

  const newChat = () => {
    if (busy) return null;
    const empty = sessions.find((x) => x.msgs.length === 1);
    if (empty) { setCurId(empty.id); setInput(''); window.setTimeout(() => inputRef.current?.focus(), 0); return empty; }
    const s = fresh();
    setSessions((all) => [s, ...all]); setCurId(s.id);
    setInput(''); window.setTimeout(() => inputRef.current?.focus(), 0);
    return s;
  };

  // 從其他 skill 切換過來時，網址帶著那句話：開一段新對話直接送出
  useEffect(() => {
    const q = route.params.get('q');
    if (!q || handledQ.current) return;
    handledQ.current = true;
    navigate(`#/scenarios?tab=${skill.def.id}`);
    const s = newChat();
    if (s) window.setTimeout(() => send(q, s), 50);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const clearSlots = () => patch(cur.id, (x) => ({ ...x, state: skill.clear(x.state) }));
  const pills = skill.pills(cur.state, ctx);
  const msgs = cur.msgs;
  const def = skill.def;

  return (
    <div className="chat-card card" ref={rootRef}>
      <aside className="chat-list">
        <button className="new-chat" onClick={newChat}><span aria-hidden>＋</span>新對話</button>
        <div className="list-h">對話紀錄</div>
        <div className="list-items">
          {sessions.map((x) => (
            <button key={x.id} className={`list-item ${x.id === cur.id ? 'on' : ''}`} onClick={() => !busy && setCurId(x.id)}>
              <b title={x.title}>{x.title}</b>
              <span>{x.msgs.length === 1 ? '尚未開始' : x.at}</span>
            </button>
          ))}
        </div>
        <button className="ghost skill-btn" onClick={() => setShowMethod(true)}>這個 skill 的內容</button>
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <h3>{cur.title === '新對話' ? `${def.name}助理` : cur.title}</h3>
          <p>用一句話描述需求，系統抽出條件、交給供需計算引擎計算，再整理成固定格式的結果（demo 用前端規則模擬模型，計算是真的）</p>
        </header>
        {showMethod && (
          <Modal title={`「${def.name}」skill 的內容`} onClose={() => setShowMethod(false)}>
            <dl className="skill-dl">
              <dt>用途</dt><dd>{def.description}</dd>
              <dt>工具</dt><dd>{def.tools.map((t) => <div key={t.name}><code>{t.name}</code><p>{t.desc}</p></div>)}</dd>
              <dt>判斷方法</dt><dd><ol>{skill.method.steps.map((x) => <li key={x}>{x}</li>)}</ol></dd>
              <dt>必要參數</dt><dd>{skill.method.params}</dd>
              <dt>輸出格式</dt><dd>{skill.method.output}</dd>
            </dl>
            <p className="note">正式版這些內容是寫給地端模型的 skill 說明檔；demo 由前端規則模擬模型的理解與說明，計算結果是真的。</p>
          </Modal>
        )}
        <div className="chat-thread" ref={threadRef}>
          {msgs.map((m) => m.role === 'user'
            ? <div key={m.id} className="msg msg-user"><div className="bubble">{m.text}</div></div>
            : (
              <div key={m.id} className="msg msg-ai">
                <div className="avatar" aria-hidden>AI</div>
                <div className="bubble">
                  {m.trace.length > 0 && (
                    <details className="trace">
                      <summary>系統動作（{m.trace.length} 步）</summary>
                      <ol>{m.trace.map((t, i) => <li key={i}>{t}</li>)}</ol>
                    </details>
                  )}
                  {m.result !== undefined && <Card r={m.result} />}
                  {m.text.map((p, i) => p.startsWith('・') ? <p key={i} className="li">{p.slice(1)}</p> : <p key={i}>{p}</p>)}
                  {m.switchTo && (
                    <div className="chips">
                      <button className="chip chip-go" onClick={() => navigate(`#/scenarios?tab=${m.switchTo!.skill}&q=${encodeURIComponent(m.switchTo!.text)}`)}>到「{m.switchTo.name}」問這句 →</button>
                    </div>
                  )}
                  {m.chips && m.id === msgs[msgs.length - 1].id && !busy && (
                    <div className="chips">{m.chips.map((c) => <button key={c} className="chip" onClick={() => send(c)}>{c}</button>)}</div>
                  )}
                </div>
              </div>
            ))}
          {busy && <div className="msg msg-ai"><div className="avatar" aria-hidden>AI</div><div className="bubble typing"><span /><span /><span /></div></div>}
        </div>
        <footer className="chat-foot">
          {pills.length > 0 && (
            <div className="ctx-bar">
              <span className="ctx-label">沿用條件</span>
              {pills.map(([k, v]) => <span key={k} className="ctx-pill"><em>{k}</em>{v}</span>)}
              <button className="link" onClick={clearSlots}>清除</button>
            </div>
          )}
          <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder={skill.placeholder} disabled={busy} />
            <button type="submit" className="primary" disabled={busy || !input.trim()}>送出</button>
          </form>
        </footer>
      </section>
    </div>
  );
}
