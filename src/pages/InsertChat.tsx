import { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { Assessment } from '../order/engine';
import { fmtInt, fmtMoney } from '../lib/format';
import { StatusTag } from './OrderInsert';
import { StatusIcon, Tip } from '../components/ui';
import SkillChat from '../components/SkillChat';
import { examplePrompts, insertChat, normDates } from '../skills/insert/skill';

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export default function InsertChat() {
  const { order, model } = useApp();
  const seeds = useMemo(() => {
    const ex = examplePrompts({ om: order!, model });
    return [{ text: ex[1], at: '今天 09:42' }, { text: ex[2], at: '昨天 16:10' }];
  }, [order, model]);
  return <SkillChat skill={insertChat} Card={InsertCard} seeds={seeds} />;
}

// 一張結果卡：摘要一定顯示，明細按需展開（方案、關鍵物料、損益），不另開大表
export function InsertCard({ r: a }: { r: Assessment }) {
  const { model } = useApp();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const it = model.items.get(a.req.item_id)!;
  const rec = a.options.find((o) => o.recommended);
  const opts = a.options.filter((o) => o.feasible).slice(0, 4);
  const mats = a.withOT.materials.filter((m) => m.status !== 'ok').slice(0, 4);
  const m = a.margin;
  const name = (id: string) => model.items.get(id)?.name ?? id;
  const unit = (id: string) => model.items.get(id)?.unit ?? '';
  return (
    <div className={`rmini rmini-${a.verdict}`}>
      <div className="rmini-top">
        <span className="v-dot" aria-hidden><StatusIcon s={a.verdict} /></span>
        <div>
          <b>{normDates(a.headline)}</b>
          <span>{model.customers.get(a.req.customer_id)?.name}・{it.name}・{fmtInt(a.req.qty)} {it.unit}・交期 {md(a.req.due_date)}</span>
        </div>
      </div>
      <div className="rmini-checks">
        {a.checks.map((c) => (
          <Tip key={c.key} content={<><b>{c.label}</b><span>{c.detail}</span></>}>
            <StatusTag s={c.status} label={c.label.replace('這張單的', '')} />
          </Tip>
        ))}
      </div>
      <div className="rmini-foot">
        <span>建議：<b>{rec?.title ?? '—'}</b>{rec?.date ? `（${md(rec.date)}）` : ''}</span>
        <span>接單多賺 <b className={m.incremental <= 0 ? 'neg' : ''}>{fmtMoney(m.incremental)}</b></span>
        <button className="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? '收起明細' : '看明細'}</button>
      </div>
      {open && (
        <div className="rmini-body">
          <div>
            <div className="rb-h">可行方案</div>
            {opts.length ? opts.map((o) => (
              <div key={o.id} className="rb-row">
                <span className={o.recommended ? 'strong' : ''}>{o.recommended ? '★ ' : ''}{o.title}</span>
                <span className="rb-num">{o.date ? md(o.date) : '—'}</span>
                <span className="rb-num">{o.extraCost ? fmtMoney(o.extraCost) : '不加錢'}</span>
              </div>
            )) : <p className="muted">交期內沒有可行方案</p>}
          </div>
          <div>
            <div className="rb-h">要注意的物料</div>
            {mats.length ? mats.map((x) => (
              <div key={x.item_id} className="rb-row">
                <span>{name(x.item_id)}</span>
                <span className={x.status === 'fail' ? 'neg' : ''}>{x.status === 'fail' ? `缺 ${fmtInt(Math.ceil(x.shortQty))} ${unit(x.item_id)}` : x.kind === 'rebuy' ? '需追加採購' : '動用安全庫存'}</span>
                <span className="rb-num muted">{x.nextReceipt ? `${md(x.nextReceipt)} 到貨` : '無在途'}</span>
              </div>
            )) : <p className="muted">原料、包材都夠</p>}
          </div>
          <div>
            <div className="rb-h">損益（增量）</div>
            <div className="rb-row"><span>營收</span><span /><span className="rb-num">{fmtMoney(m.revenue)}</span></div>
            <div className="rb-row"><span>原料＋包材</span><span /><span className="rb-num">− {fmtMoney(m.revenue - m.contribution)}</span></div>
            {m.extraCost > 0 && <div className="rb-row"><span>加班等額外成本</span><span /><span className="rb-num">− {fmtMoney(m.extraCost)}</span></div>}
            <div className="rb-row total"><span>接單多賺</span><span /><span className="rb-num">{fmtMoney(m.incremental)}</span></div>
            <p className="muted small">全成本毛利率 {(m.gpPct * 100).toFixed(1)}%（參考）</p>
          </div>
          <div className="rb-actions">
            <button className="ghost" onClick={() => setNote('demo：已存成草稿')}>存成草稿</button>
            {note && <span className="muted">{note}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
