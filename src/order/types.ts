// 供需計算引擎的資料格式（對應 public/data/order/*.json）
// 編號對應「資料確認清單」：D03～D16、R01～R10

export interface CalendarDay { date: string; day_type: '工作日' | '加班日' | '休假'; note: string | null }
export interface ProductionLine {
  line_id: string; name: string; company_id: string; line_type: '自動' | '手工';
  normal_hours: number; max_overtime_weekday: number; max_overtime_saturday: number; std_headcount: number; note: string;
}
export interface Maintenance { line_id: string; date: string; hours: number; note: string }
export interface LineCapability {
  line_id: string; item_id: string; rate_per_hour: number; rate_basis: '每小時' | '每人每小時';
  priority: number; min_batch: number; setup_minutes: number;
}
export interface ChangeoverRules { default_setup_minutes: number; allergen_cleaning_minutes: number; allergen_last_in_day: boolean; controlled_allergens?: string[]; note: string }
export interface StaffAttendance { date: string; line_id: string; available_headcount: number; note: string | null }
export interface OvertimePolicy { weekday_rate_per_person_hour: number; saturday_rate_per_person_hour: number; monthly_cap_per_person_hours: number; note: string }
export interface Freezer { capacity_pallets: number; safe_level_ratio: number; other_used_pallets: number; current_used_pallets: number; note: string }
export interface CustomerRule { customer_id: string; acceptance_ratio: number; priority: 'A' | 'B' | 'C'; can_delay: boolean; late_penalty: string | null }
export interface PlanningRule { rule_id: string; name: string; value: unknown; note?: string }
export interface SalesOrder { order_no: string; line_no: number; order_date: string; customer_id: string; item_id: string; qty: number; shipped_qty: number; due_date: string; status: string }
export interface InventoryLot { item_id: string; warehouse: string; lot_no: string | null; qty: number; mfg_date: string | null; exp_date: string | null }
export interface WorkOrder { mo_no: string; item_id: string; planned_qty: number; completed_qty: number; plan_start: string; plan_end: string; status: string }
export interface ScheduleRow { date: string; line_id: string; mo_no: string; item_id: string; qty: number; hours: number; overtime?: boolean }
export interface PurchaseOrder { po_no: string; supplier_id: string; item_id: string; qty: number; received_qty: number; order_date: string; expected_date: string; status: string }
export interface InsertScenario { id: string; title: string; customer_id: string; item_id: string; qty: number; due_date: string; note: string }
export interface SourceRef { file: string; code: string; name: string; source_type: string; erp_ref: string | null }
export interface OrderMeta { source: string; snapshot_at: string; horizon_end: string; generated_at: string; row_counts: Record<string, number> }

export interface OrderData {
  order_meta: OrderMeta;
  calendar: CalendarDay[];
  production_lines: ProductionLine[];
  maintenance: Maintenance[];
  line_capabilities: LineCapability[];
  changeover_rules: ChangeoverRules;
  staff_attendance: StaffAttendance[];
  overtime_policy: OvertimePolicy;
  freezer: Freezer;
  customer_rules: CustomerRule[];
  planning_rules: PlanningRule[];
  sales_orders: SalesOrder[];
  inventory: InventoryLot[];
  work_orders: WorkOrder[];
  production_schedule: ScheduleRow[];
  purchase_orders: PurchaseOrder[];
  insert_scenarios: InsertScenario[];
  sources: SourceRef[];
}

const FILES = [
  'order_meta', 'calendar', 'production_lines', 'maintenance', 'line_capabilities', 'changeover_rules', 'staff_attendance',
  'overtime_policy', 'freezer', 'customer_rules', 'planning_rules', 'sales_orders', 'inventory', 'work_orders',
  'production_schedule', 'purchase_orders', 'insert_scenarios', 'sources',
] as const;

// 資料來源轉接層：之後接 ERP、生管排程等真實資料時，只改這裡
export async function loadOrderData(base = `${import.meta.env.BASE_URL}data/order`): Promise<OrderData> {
  const entries = await Promise.all(FILES.map(async (f) => {
    const res = await fetch(`${base}/${f}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`讀取 order/${f}.json 失敗（${res.status}）`);
    return [f, await res.json()] as const;
  }));
  return Object.fromEntries(entries) as unknown as OrderData;
}
