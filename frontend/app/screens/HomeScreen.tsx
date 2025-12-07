import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Platform,
  Text,
  View,
  Pressable,
  useWindowDimensions,
  ScrollView,
} from "react-native";


const LAGS = [1, 2, 3];                 // use 1~3 step lags
const USE_DATETIME_FEATURES = true;     // add cyclic time features if datetime column exists

function sincos(value: number, period: number) {
  const angle = (2 * Math.PI * value) / period;
  return { sin: Math.sin(angle), cos: Math.cos(angle) };
}

function getDateParts(d: Date) {
  const w = d.getDay();   // 0..6
  const m = d.getMonth(); // 0..11
  return { weekday: w, month: m };
}

// --- Recharts (Web only) ---
let Recharts: any = {};
if (Platform.OS === "web") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Recharts = require("recharts");
}
const {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} = Recharts;

// --- XLSX (Web only) ---
let XLSX: any = null;
if (Platform.OS === "web") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  XLSX = require("xlsx");
}

// ---------- Types ----------
type Row = { [key: string]: number | string | Date | null };
type DataFrame = {
  columns: string[]; // includes 'datetime' if present
  rows: Row[]; // parsed rows (objects with keys = columns)
  numericCols: string[]; // numeric columns only (exclude 'datetime')
  datetimeKey?: string; // detected datetime column name (if any)
};

type CartNode =
  | {
      kind: "leaf";
      value: number;
      size: number;
      depth: number;
    }
  | {
      kind: "split";
      feature: number; // index in feature vector
      threshold: number;
      left: CartNode;
      right: CartNode;
      size: number;
      depth: number;
    };

type Model = {
  type: "cart";
  nFeatures: number;
  root: CartNode;
  predictBatch: (X: number[][]) => number[];
};

// ---------- CSV Parsing ----------
function parseCSV(text: string): DataFrame {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return { columns: [], rows: [], numericCols: [] };

  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Row[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i], header.length);
    const row: Row = {};
    header.forEach((h, idx) => {
      row[h] = coerce(parts[idx]);
    });
    rows.push(row);
  }

  // detect datetime-like column
  const datetimeKey = header.find(
    (h) =>
      h.toLowerCase() === "datetime" ||
      h.toLowerCase() === "date" ||
      h.toLowerCase() === "time"
  );

  const numericCols = header.filter((h) => {
    if (datetimeKey && h === datetimeKey) return false;
    // consider numeric if more than half of values are numbers
    let nNum = 0;
    for (const r of rows) if (typeof r[h] === "number") nNum++;
    return nNum >= Math.max(1, Math.floor(rows.length * 0.5));
  });

  return { columns: header, rows, numericCols, datetimeKey };
}

function splitCsvLine(line: string, nCols: number): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && (i === 0 || line[i - 1] !== "\\")) {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  while (out.length < nCols) out.push("");
  return out;
}

function coerce(v: string | undefined): number | string | Date | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;

  // ISO-like date?
  const maybeDate = new Date(t);
  if (!isNaN(+maybeDate) && /[-T:\/]/.test(t)) return maybeDate;

  const n = Number(t);
  if (!isNaN(n)) return n;
  return t;
}

// ---------- XLSX Parsing (SheetJS) ----------
async function parseXLSX(file: File): Promise<DataFrame> {
  if (!XLSX) throw new Error("XLSX not available on this platform");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });

  // Choose first sheet
  const first = wb.SheetNames[0];
  const ws = wb.Sheets[first];

  // to_json with header
  const json: any[] = XLSX.utils.sheet_to_json(ws, { raw: true, defval: null });

  if (!json.length) return { columns: [], rows: [], numericCols: [] };

  // Columns from keys
  const columns = Array.from(
    new Set(json.flatMap((r) => Object.keys(r as object)))
  );

  // Normalize & coerce
  const rows: Row[] = json.map((r) => {
    const out: Row = {};
    for (const c of columns) {
      const v = (r as any)[c];
      if (typeof v === "string") {
        out[c] = coerce(v);
      } else if (typeof v === "number") {
        out[c] = v;
      } else if (v && v instanceof Date) {
        out[c] = v;
      } else {
        out[c] = v ?? null;
      }
    }
    return out;
  });

  // detect datetime
  const datetimeKey = columns.find(
    (h) =>
      h.toLowerCase() === "datetime" ||
      h.toLowerCase() === "date" ||
      h.toLowerCase() === "time"
  );

  const numericCols = columns.filter((h) => {
    if (datetimeKey && h === datetimeKey) return false;
    let nNum = 0;
    for (const r of rows) if (typeof r[h] === "number") nNum++;
    return nNum >= Math.max(1, Math.floor(rows.length * 0.5));
  });

  return { columns, rows, numericCols, datetimeKey };
}

// ---------- CART (tiny decision tree regressor) ----------
function variance(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length;
}

function buildCART(
  X: number[][],
  y: number[],
  depth = 0,
  maxDepth = 4,
  minLeaf = 8
): CartNode {
  const n = y.length;
  if (n <= minLeaf || depth >= maxDepth) {
    const val = y.reduce((a, b) => a + b, 0) / Math.max(1, n);
    return { kind: "leaf", value: val, size: n, depth };
  }

  const parentVar = variance(y);
  let bestGain = 0;
  let bestFeat = -1;
  let bestThr = 0;
  let bestLeftIdx: number[] = [];
  let bestRightIdx: number[] = [];

  const nFeat = X[0]?.length ?? 0;

  for (let f = 0; f < nFeat; f++) {
    // try candidate thresholds as quantiles (10 bins)
    const vals = X.map((row) => row[f]).filter((v) => Number.isFinite(v));
    if (!vals.length) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const candidates: number[] = [];
    for (let q = 1; q < 10; q++) {
      const idx = Math.floor((q * sorted.length) / 10);
      if (idx >= 0 && idx < sorted.length) candidates.push(sorted[idx]);
    }
    for (const thr of candidates) {
      const L: number[] = [];
      const R: number[] = [];
      const Li: number[] = [];
      const Ri: number[] = [];
      for (let i = 0; i < n; i++) {
        const v = X[i][f];
        if (v <= thr) {
          L.push(y[i]);
          Li.push(i);
        } else {
          R.push(y[i]);
          Ri.push(i);
        }
      }
      if (L.length < minLeaf || R.length < minLeaf) continue;
      const gain =
        parentVar -
        (L.length / n) * variance(L) -
        (R.length / n) * variance(R);
      if (gain > bestGain) {
        bestGain = gain;
        bestFeat = f;
        bestThr = thr;
        bestLeftIdx = Li;
        bestRightIdx = Ri;
      }
    }
  }

  if (bestGain <= 1e-12 || bestFeat < 0) {
    const val = y.reduce((a, b) => a + b, 0) / Math.max(1, n);
    return { kind: "leaf", value: val, size: n, depth };
  }

  const XL = bestLeftIdx.map((i) => X[i]);
  const XR = bestRightIdx.map((i) => X[i]);
  const yL = bestLeftIdx.map((i) => y[i]);
  const yR = bestRightIdx.map((i) => y[i]);

  return {
    kind: "split",
    feature: bestFeat,
    threshold: bestThr,
    left: buildCART(XL, yL, depth + 1, maxDepth, minLeaf),
    right: buildCART(XR, yR, depth + 1, maxDepth, minLeaf),
    size: n,
    depth,
  };
}

function predictTree(node: CartNode, x: number[]): number {
  if (node.kind === "leaf") return node.value;
  return x[node.feature] <= node.threshold
    ? predictTree(node.left, x)
    : predictTree(node.right, x);
}

function fitCART(X: number[][], y: number[]): Model {
  const root = buildCART(X, y);
  return {
    type: "cart",
    nFeatures: X[0]?.length ?? 0,
    root,
    predictBatch: (XX: number[][]) => XX.map((r) => predictTree(root, r)),
  };
}

// ---------- Color palette ----------
const PALETTE = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#393b79",
  "#637939",
  "#8c6d31",
  "#843c39",
  "#7b4173",
];

function colorFor(idx: number) {
  return PALETTE[idx % PALETTE.length];
}

// ---------- HomeScreen ----------
export default function HomeScreen() {
  const { width, height } = useWindowDimensions();
  const [df, setDf] = useState<DataFrame | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<string | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [prediction, setPrediction] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const accept = ".csv, .xlsx, .xls";

  const onPickFile = useCallback(() => {
    if (Platform.OS === "web") {
      if (!fileInputRef.current) return;
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }, []);

  const onFileChange = useCallback(async (e: any) => {
    try {
      const file: File | undefined = e.target?.files?.[0];
      if (!file) return;
      const name = (file.name || "").toLowerCase();

      setStatus("Parsing...");
      let parsed: DataFrame;

      if (name.endsWith(".csv")) {
        const text = await file.text();
        parsed = parseCSV(text);
      } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
        parsed = await parseXLSX(file);
      } else {
        setStatus("Unsupported file type. Please select CSV/XLSX.");
        return;
      }

      // default visibility on
      const vis: Record<string, boolean> = {};
      for (let i = 0; i < parsed.numericCols.length; i++) {
        vis[parsed.numericCols[i]] = true;
      }

      setDf(parsed);
      setVisible(vis);
      // auto-select first numeric column as target
      setTarget(parsed.numericCols[0] ?? null);
      setModel(null);
      setPrediction(null);
      setStatus("Loaded.");
    } catch (err: any) {
      setStatus(`Parse error: ${err?.message ?? String(err)}`);
    }
  }, []);

  const toggleSeries = useCallback((key: string) => {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

    // ----- Build multivariate time-series features: X(t) -> y(t+1) -----
    const Xy = useMemo(() => {
    if (!df || !target) {
        return {
        X: [] as number[][],
        y: [] as number[],
        featNames: [] as string[],
        makeNextX: () => [] as number[],
        maxLag: 0,
        };
    }

    const datetimeKey = df.datetimeKey;
    const allSeries = df.numericCols;
    const exo = allSeries.filter((c) => c !== target); // exogenous series

    const featNames: string[] = [];

    // base: current-time exogenous features (t)
    for (const s of exo) featNames.push(`${s}(t)`);

    // lags for target and all exogenous
    for (const l of LAGS) {
        featNames.push(`${target}(t-${l})`);
        for (const s of exo) featNames.push(`${s}(t-${l})`);
    }

    // datetime cyclic features
    if (USE_DATETIME_FEATURES && datetimeKey) {
        featNames.push("dow_sin", "dow_cos", "mon_sin", "mon_cos");
    }

    const maxLag = Math.max(0, ...LAGS);
    const X: number[][] = [];
    const y: number[] = [];

    // helper to read a numeric cell (or NaN)
    const getNum = (rowIdx: number, col: string): number =>
        typeof df.rows[rowIdx]?.[col] === "number" ? (df.rows[rowIdx][col] as number) : NaN;

    // compose feature vector for an index t (predicting y at t+1)
    const makeXAt = (t: number): number[] => {
        const row: number[] = [];

        // current-time exogenous at t
        for (const s of exo) row.push(getNum(t, s));

        // lags for target & exogenous
        for (const l of LAGS) {
        row.push(getNum(t - l, target)); // target lag
        for (const s of exo) row.push(getNum(t - l, s)); // exo lag
        }

        // datetime features at t
        if (USE_DATETIME_FEATURES && datetimeKey) {
        const dv = df.rows[t]?.[datetimeKey];
        if (dv instanceof Date && !isNaN(+dv)) {
            const { weekday, month } = getDateParts(dv);
            const d = sincos(weekday, 7);
            const m = sincos(month, 12);
            row.push(d.sin, d.cos, m.sin, m.cos);
        } else {
            row.push(0, 0, 0, 0); // fallback
        }
        }

        return row;
    };

    // Build dataset: use rows [maxLag .. N-2] as feature rows (predict y at t+1)
    const N = df.rows.length;
    for (let t = maxLag; t <= N - 2; t++) {
        const x = makeXAt(t);
        if (x.some((v) => !Number.isFinite(v))) continue; // drop rows with NaN
        const yNext = getNum(t + 1, target);
        if (!Number.isFinite(yNext)) continue;
        X.push(x);
        y.push(yNext);
    }

    // build "next" feature for prediction at N (use last available t = N-1)
    const makeNextX = (): number[] => {
        const t = N - 1;
        return makeXAt(t);
    };

    return { X, y, featNames, makeNextX, maxLag };
    }, [df, target]);


  const train = useCallback(() => {
    if (!df || !target) {
      setStatus("Load data and choose a target first.");
      return;
    }
    const { X, y } = Xy;
    if (X.length < 20) {
      setStatus("Not enough rows to train (need >= 20 after cleaning).");
      return;
    }
    const m = fitCART(X, y);
    setModel(m);
    setPrediction(null);
    setStatus(`Trained CART with ${m.nFeatures} features on ${X.length} rows.`);
  }, [df, target, Xy]);

    const predict = useCallback(() => {
    if (!df || !target || !model) {
        setStatus("Train a model first.");
        return;
    }
    const xNext = Xy.makeNextX();
    if (!xNext.length || xNext.some((v) => !Number.isFinite(v))) {
        setStatus("Not enough history to build features for t+1. Add more rows.");
        return;
    }
    const yhat = model.predictBatch([xNext])[0];
    setPrediction(yhat);
    setStatus(`Predicted next 1 step: ${target}(t+1).`);
    }, [df, target, model, Xy]);

  // ----- Chart Data -----
  const chartData = useMemo(() => {
    if (!df) return [];
    // Create plotting rows: X-axis will be index or datetime label
    return df.rows.map((r, idx) => {
      const o: any = { _i: idx };
      if (df.datetimeKey && r[df.datetimeKey]) {
        const v = r[df.datetimeKey];
        o._x =
          v instanceof Date
            ? v.toISOString()
            : typeof v === "string"
            ? v
            : String(v);
      } else {
        o._x = String(idx + 1);
      }
      for (const c of df.numericCols) {
        o[c] = typeof r[c] === "number" ? (r[c] as number) : null;
      }
      return o;
    });
  }, [df]);

  const series = df?.numericCols ?? [];

  // ----- Styling helpers -----
  const CONTENT_MAX_W = 980;
  const CHART_H = Math.min(Math.max(360, Math.floor(height * 0.45)), 560);

  const renderWebInputs = () =>
    Platform.OS === "web" ? (
      <input
        ref={fileInputRef as any}
        type="file"
        accept={accept}
        onChange={onFileChange}
        style={{ display: "none" }}
      />
    ) : null;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "#0b0c10",
      }}
    >
      {renderWebInputs()}
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingBottom: 48 }}>
        <View style={{ width: "100%", maxWidth: CONTENT_MAX_W, padding: 16, gap: 16 }}>
          {/* Header */}
          <View style={{ gap: 8 }}>
            <Pressable
              onPress={() =>
                Linking.openURL("https://github.com/europanite/client_side_ml")
              }
            >
              <Text
                style={{
                  color: "#fff",
                  fontSize: 22,
                  fontWeight: "700",
                  textDecorationLine: "underline",
                }}
              >
                Client Side Machine Learning
              </Text>
            </Pressable>
            <Text style={{ color: "#9aa0a6" }}>
              A browser-based multivariate time series forecasting tool powered by CART. No installation, registration, or payment required.
            </Text>
          </View>
          {/* Action row */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}
          >
            <ActionButton label="Import CSV/XLSX" onPress={onPickFile} bg="#1a73e8" />
            <ActionButton label="Train (Decision Tree)" onPress={train} bg="#34a853" />
            <ActionButton label="Predict +1" onPress={predict} bg="#f9ab00" fg="#000" />
            {prediction != null && (
              <View
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderRadius: 10,
                  backgroundColor: "#202124",
                }}
              >
                <Text style={{ color: "#fff" }}>
                  Prediction ({target ?? "?"}):{" "}
                  <Text style={{ color: "#f9ab00", fontWeight: "700" }}>
                    {Number.isFinite(prediction) ? prediction.toFixed(4) : String(prediction)}
                  </Text>
                </Text>
              </View>
            )}
          </View>

          {/* Target chooser */}
          <View style={{ gap: 8 }}>
            <Text style={{ color: "#9aa0a6" }}>Target variable</Text>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {series.map((s, idx) => (
                <Pressable
                  key={s}
                  onPress={() => setTarget(s)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 999,
                    borderWidth: 2,
                    borderColor: colorFor(idx),
                    backgroundColor: target === s ? colorFor(idx) : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: target === s ? "#000" : colorFor(idx),
                      fontWeight: "700",
                    }}
                  >
                    {s}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Series toggles (color-coded) */}
          <View style={{ gap: 8 }}>
            <Text style={{ color: "#9aa0a6" }}>Series visibility</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {series.map((s, idx) => {
                const on = visible[s] ?? true;
                const c = colorFor(idx);
                return (
                  <Pressable
                    key={s}
                    onPress={() => toggleSeries(s)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: on ? c : "transparent",
                      borderWidth: 2,
                      borderColor: c,
                    }}
                  >
                    <Text style={{ color: on ? "#000" : c, fontWeight: "700" }}>{s}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Chart */}
          <View
            style={{
              width: "100%",
              height: CHART_H,
              backgroundColor: "#111316",
              borderRadius: 16,
              padding: 12,
            }}
          >
            {Platform.OS === "web" ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                  <CartesianGrid stroke="#2b2f36" strokeDasharray="3 3" />
                  <XAxis dataKey="_x" stroke="#9aa0a6" />
                  <YAxis stroke="#9aa0a6" />
                  <Tooltip />
                  <Legend />
                  {series.map((s, idx) =>
                    visible[s] ? (
                      <Line
                        key={s}
                        type="monotone"
                        dataKey={s}
                        stroke={colorFor(idx)}
                        dot={false}
                        strokeWidth={2}
                        isAnimationActive={false}
                      />
                    ) : null
                  )}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: "#9aa0a6", textAlign: "center", padding: 16 }}>
                  Charts are available on the Web build. Please open this app in a browser.
                </Text>
              </View>
            )}
          </View>

          {/* Status */}
          {status ? (
            <View style={{ paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#202124", borderRadius: 10 }}>
              <Text style={{ color: "#9aa0a6" }}>{status}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* Hidden <input> only on web */}
      {Platform.OS === "web" ? (
        <input
          ref={fileInputRef as any}
          type="file"
          accept={accept}
          onChange={onFileChange}
          style={{ display: "none" }}
        />
      ) : null}
    </View>
  );
}

// ---------- Small UI component ----------
function ActionButton({
  label,
  onPress,
  bg,
  fg = "#fff",
}: {
  label: string;
  onPress: () => void;
  bg: string;
  fg?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: bg,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 10,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color: fg, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}
