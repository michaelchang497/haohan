import type { RawData } from './types';

// 資料來源轉接層：之後接上真實 ERP 匯出時，只需要改這個檔案
// （例如改成呼叫 API，或讀取 ETL 產出的檔案），畫面與計算邏輯不用動。
const TABLES = [
  'meta', 'companies', 'channels', 'sales_reps', 'suppliers', 'customers',
  'items', 'bom', 'price_contracts', 'sales', 'purchases', 'monthly_actual_cost',
] as const;

export async function loadRawData(base = `${import.meta.env.BASE_URL}data`): Promise<RawData> {
  const entries = await Promise.all(
    TABLES.map(async (t) => {
      const res = await fetch(`${base}/${t}.json`, { cache: "no-store" });
      if (!res.ok) throw new Error(`讀取 ${t}.json 失敗（${res.status}）`);
      return [t, await res.json()] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as RawData;
}
