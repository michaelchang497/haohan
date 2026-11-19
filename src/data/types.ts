// 標準中介格式（Raw layer）
// 不論資料來自ERP 的哪個版本、用什麼方式匯出，都先轉成這個格式。
// 欄位說明與ERP 對應見 docs/data-schema.md

export type ItemType = '原料' | '包材' | '半成品' | '成品';

export interface Meta {
  source: string;
  as_of: string;            // 報表基準日
  data_through: string;     // 資料涵蓋到哪一天
  last_closed_month: string;// 最後一個月結完成的月份（YYYY-MM）
  currency: string;
  generated_at: string;
  row_counts: Record<string, number>;
}

export interface Company { company_id: string; name: string; role: string }
export interface Channel { channel_id: string; name: string }
export interface SalesRep { rep_id: string; name: string }
export interface Supplier { supplier_id: string; name: string }

export interface Customer {
  customer_id: string;
  name: string;
  company_id: string;       // 由哪家公司銷售
  channel_id: string;
  rep_id: string;
  region: string;
  is_intercompany: boolean; // 集團內部交易對象
}

export interface Item {
  item_id: string;
  name: string;
  type: ItemType;
  category: string;
  unit: string;
  std_cost: number;              // 標準成本（主檔，人工設定）
  std_labor_overhead: number;    // 每單位人工＋製費
  company_id: string;            // 生產公司
  shelf_life_days: number | null;
  // 計畫參數（供需計算引擎用）
  purchase_lead_days?: number;    // 採購前置天數（原料、包材）
  moq?: number | null;            // 最小訂購量
  safety_stock?: number;          // 安全存量
  custom_for_customer?: string | null; // 客製包材的專屬客戶
  allergens?: string[];           // 過敏原（半成品、成品）
  storage?: '常溫' | '冷凍';
  pallet_qty?: number | null;     // 每板數量（冷凍庫容量計算用）
}

export interface BomLine {
  parent_id: string;     // 主件
  seq: number;
  component_id: string;  // 元件
  qty: number;           // 每 1 單位主件的用量
  unit: string;
  loss_rate: number;     // 損耗率
  version: string;
  effective_from: string;
}

export interface PriceContract {
  customer_id: string;
  item_id: string;
  price: number;
  quoted_on: string;
  cost_at_quote: number;
  currency: string;
}

export interface SalesLine {
  doc_no: string;
  line_no: number;
  date: string;
  company_id: string;
  customer_id: string;
  item_id: string;
  doc_type: '銷貨' | '銷退';
  qty: number;
  unit_price: number;
  amount: number;
}

export interface PurchaseLine {
  doc_no: string;
  date: string;
  company_id: string;
  supplier_id: string;
  item_id: string;
  qty: number;
  unit_price: number;
  amount: number;
}

export interface MonthlyActualCost {
  month: string;
  item_id: string;
  actual_unit_cost: number;
}

export interface RawData {
  meta: Meta;
  companies: Company[];
  channels: Channel[];
  sales_reps: SalesRep[];
  suppliers: Supplier[];
  customers: Customer[];
  items: Item[];
  bom: BomLine[];
  price_contracts: PriceContract[];
  sales: SalesLine[];
  purchases: PurchaseLine[];
  monthly_actual_cost: MonthlyActualCost[];
}
