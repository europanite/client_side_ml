import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View, Pressable, useWindowDimensions } from "react-native";

/**
 * HomeScreen
 * - Import time-series CSV from a file picker
 * - Plot all series with distinct colors (web: HTMLCanvasElement; native
 * - Choose a target variable
 * - Train: try a tiny CART regressor.
 * - Predict: one-step-ahead prediction using last-available features (current row) to predict next target.
 *
 * No extra dependencies; works in Expo web export.
 */

// ---------- Types ----------
type Row = { [key: string]: number | Date | string | null };
type DataFrame = {
  columns: string[];           // includes 'datetime'
  rows: Row[];                 // parsed rows
  numericCols: string[];       // numeric columns only (exclude datetime)
};

type Model = {
  type: "cart";
  fit: (X: number[][], y: number[]) => Promise<void> | void;
  predict: (X: number[][]) => number[]; // batch predict
};

// ---------- CSV Parsing ----------
function parseCSV(text: string): DataFrame {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) {
    return { columns: [], rows: [], numericCols: [] };
  }
  const header = lines[0].split(",").map(s => s.trim());
  const dtIdx = header.findIndex(h => h.toLowerCase() === "datetime");

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i].split(",");
    if (raw.length !== header.length) {
      // Skip malformed lines gracefully.
      continue;
    }
    const r: Row = {};
    header.forEach((h, j) => {
      if (j === dtIdx) {
        const d = new Date(raw[j]);
        r[h] = isNaN(+d) ? null : d;
      } else {
        const v = Number(raw[j]);
        r[h] = isNaN(v) ? null : v;
      }
    });
    rows.push(r);
  }

  // Detect numeric columns (drop non-numeric or mostly-null)
  const numericCols = header.filter(h => h !== header[dtIdx]).filter(col => {
    let ok = 0, total = 0;
    for (const r of rows) {
      if (typeof r[col] === "number") { ok++; }
      total++;
    }
    return ok >= Math.max(2, Math.floor(total * 0.8)); // at least 80% numeric
  });

  return { columns: header, rows, numericCols };
}

// ---------- Feature engineering (lag-1) ----------
function buildSupervised(df: DataFrame, target: string) {
  // Features: all numeric columns (including target) at t, plus lag-1 of all numeric columns.
  // Label: target at t (next-step prediction uses row[t] features to predict y[t+1])
  const dtCol = df.columns.find(c => c.toLowerCase() === "datetime") ?? "datetime";
  const rows = df.rows
    .filter(r => r[dtCol] instanceof Date)
    .sort((a, b) => (a[dtCol] as Date).getTime() - (b[dtCol] as Date).getTime());

  const X: number[][] = [];
  const y: number[] = [];
  const cols = df.numericCols;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];

    // Skip if any required numeric is null
    const curNums = cols.map(c => (typeof cur[c] === "number" ? (cur[c] as number) : NaN));
    const prevNums = cols.map(c => (typeof prev[c] === "number" ? (prev[c] as number) : NaN));
    if (curNums.some(n => !isFinite(n)) || prevNums.some(n => !isFinite(n))) continue;

    const feat = [...curNums, ...prevNums]; // [current features..., lag1 features...]
    const label = cur[target] as number;
    if (!isFinite(label)) continue;

    X.push(feat);
    y.push(label);
  }

  return { X, y, orderedRows: rows };
}

// ---------- Tiny CART Regressor ----------
class CARTRegressor {
  private root: any = null;
  constructor(private maxDepth = 3, private minLeaf = 5) {}

  fit(X: number[][], y: number[]) {
    this.root = this.buildNode(X, y, 0);
  }

  predict(X: number[][]): number[] {
    return X.map(x => this.traverse(this.root, x));
  }

  private buildNode(X: number[][], y: number[], depth: number): any {
    if (depth >= this.maxDepth || X.length <= this.minLeaf) {
      return { leaf: true, value: mean(y) };
    }
    const { feat, thresh, leftIdx, rightIdx, gain } = bestSplit(X, y);
    if (gain <= 0 || leftIdx.length === 0 || rightIdx.length === 0) {
      return { leaf: true, value: mean(y) };
    }
    const XL = leftIdx.map(i => X[i]), yL = leftIdx.map(i => y[i]);
    const XR = rightIdx.map(i => X[i]), yR = rightIdx.map(i => y[i]);
    return {
      leaf: false, feat, thresh,
      left: this.buildNode(XL, yL, depth + 1),
      right: this.buildNode(XR, yR, depth + 1),
    };
  }

  private traverse(node: any, x: number): number;
  private traverse(node: any, x: number[]): number;
  private traverse(node: any, x: any): number {
    if (node.leaf) return node.value;
    const v = (x as number[])[node.feat];
    if (v <= node.thresh) return this.traverse(node.left, x);
    return this.traverse(node.right, x);
  }
}

function variance(arr: number[]) {
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
}
function mean(arr: number[]) {
  return arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
}
function bestSplit(X: number[][], y: number[]) {
  const nFeat = X[0]?.length ?? 0;
  const baseVar = variance(y);
  let best = { feat: 0, thresh: 0, leftIdx: [] as number[], rightIdx: [] as number[], gain: -Infinity };

  for (let f = 0; f < nFeat; f++) {
    // choose candidate thresholds as midpoints of sorted unique values
    const idx = X.map((row, i) => [row[f], i] as const).sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < idx.length; k++) {
      if (idx[k][0] === idx[k - 1][0]) continue;
      const thr = (idx[k][0] + idx[k - 1][0]) / 2;
      const left: number[] = [], right: number[] = [];
      for (const [, i] of idx) {
        if (X[i][f] <= thr) left.push(i); else right.push(i);
      }
      if (left.length === 0 || right.length === 0) continue;
      const vL = variance(left.map(i => y[i]));
      const vR = variance(right.map(i => y[i]));
      const gain = baseVar - (vL * left.length + vR * right.length) / y.length;
      if (gain > best.gain) {
        best = { feat: f, thresh: thr, leftIdx: left, rightIdx: right, gain };
      }
    }
  }
  return best;
}

// ---------- Simple color palette ----------
const COLORS = [
  "#1f77b4", "#ff7f0e", "#2ca02c",
  "#d62728", "#9467bd", "#8c564b",
  "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"
];

// ---------- Canvas Line Chart (web only) ----------
function drawChart(
  canvas: HTMLCanvasElement,
  df: DataFrame,
  width: number,
  height: number
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const dtCol = df.columns.find(c => c.toLowerCase() === "datetime") ?? "datetime";
  const rows = df.rows
    .filter(r => r[dtCol] instanceof Date)
    .sort((a, b) => (a[dtCol] as Date).getTime() - (b[dtCol] as Date).getTime());

  if (rows.length < 2 || df.numericCols.length === 0) {
    ctx.fillStyle = "#333";
    ctx.fillText("No chartable data", 10, 20);
    return;
  }

  const left = 50, right = 10, top = 20, bottom = 30;
  const W = width - left - right;
  const H = height - top - bottom;

  const minT = (rows[0][dtCol] as Date).getTime();
  const maxT = (rows[rows.length - 1][dtCol] as Date).getTime();

  // axis
  ctx.strokeStyle = "#888";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, height - bottom);
  ctx.lineTo(width - right, height - bottom);
  ctx.moveTo(left, top);
  ctx.lineTo(left, height - bottom);
  ctx.stroke();

  // For each series, compute min/max to share y-axis
  let yMin = +Infinity, yMax = -Infinity;
  for (const col of df.numericCols) {
    for (const r of rows) {
      const v = r[col] as number;
      if (!isFinite(v)) continue;
      yMin = Math.min(yMin, v);
      yMax = Math.max(yMax, v);
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax) || yMin === yMax) {
    yMin = yMin || 0; yMax = yMin + 1;
  }

  // Draw lines
  df.numericCols.forEach((col, idx) => {
    ctx.strokeStyle = COLORS[idx % COLORS.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;

    rows.forEach(r => {
      const t = (r[dtCol] as Date).getTime();
      const v = r[col] as number;
      if (!isFinite(v)) return;
      const x = left + ((t - minT) / Math.max(1, (maxT - minT))) * W;
      const y = top + (1 - (v - yMin) / Math.max(1e-9, (yMax - yMin))) * H;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    });

    ctx.stroke();

    // Legend
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(width - right - 120, top + 10 + idx * 16, 12, 12);
    ctx.fillStyle = "#222";
    ctx.fillText(col, width - right - 100, top + 20 + idx * 16);
  });
}

// ---------- Main Component ----------
export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const [df, setDf] = useState<DataFrame>({ columns: [], rows: [], numericCols: [] });
  const [target, setTarget] = useState<string>("");
  const [status, setStatus] = useState<string>("Ready.");
  const [model, setModel] = useState<Model | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Render chart (web only)
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!canvasRef.current || df.rows.length === 0) return;
    drawChart(canvasRef.current, df, Math.min(960, Math.max(360, width - 24)), 360);
  }, [df, width]);

  // File import handler
  const onFileChange = useCallback(async (file: File) => {
    const text = await file.text();
    const parsed = parseCSV(text);
    setDf(parsed);
    if (parsed.numericCols.length > 0) {
      setTarget(parsed.numericCols[0]);
    }
    setStatus(`Loaded ${parsed.rows.length} rows. Numeric: ${parsed.numericCols.join(", ")}`);
  }, []);

  // Build supervised dataset
  const supervised = useMemo(() => {
    if (!df.rows.length || !target) return null;
    return buildSupervised(df, target);
  }, [df, target]);

  // Train button
  const onTrain = useCallback(async () => {
    if (!supervised || supervised.X.length < 10) {
      setStatus("Not enough data to train.");
      return;
    }

    const cart = new CARTRegressor(4, 5);
    cart.fit(supervised.X, supervised.y);
    const cartModel: Model = {
        type: "cart",
        fit: () => {},
        predict: (Xtest: number[][]) => cart.predict(Xtest),
    };
    setStatus("Trained a CART model.");

    setModel(cartModel);
  }, [supervised]);

  // Predict button
  const onPredict = useCallback(() => {
    if (!supervised || !model) {
      setStatus("Train a model first.");
      return;
    }
    // Use the last available feature row to predict the next target (one-step ahead).
    const lastX = supervised.X.at(-1)!; // current features
    const pred = model.predict([lastX])[0];
    setStatus(`Next ${target} (t+1) predicted: ${pred.toFixed(3)} [${model.type}]`);
  }, [model, supervised, target]);

  // ---------- UI ----------
  return (
    <View style={{ flex: 1, padding: 12, gap: 12 }}>
      <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: "600" }}>
        Client-Side Time Series
      </Text>

      {/* File picker (web native <input>) */}
      <View style={{ gap: 6 }}>
        <Text style={{ fontWeight: "600" }}>1) Import CSV (must include a 'datetime' column):</Text>
        {Platform.OS === "web" ? (
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) onFileChange(f);
            }}
          />
        ) : (
          <Text>File picker is available on web build. On native, please supply data via web.</Text>
        )}
      </View>

      {/* Target selection */}
      <View style={{ gap: 6 }}>
        <Text style={{ fontWeight: "600" }}>2) Choose target variable:</Text>
        {df.numericCols.length === 0 ? (
          <Text>- (Load CSV first)</Text>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {df.numericCols.map((c) => (
              <Pressable
                key={c}
                onPress={() => setTarget(c)}
                style={{
                  paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                  backgroundColor: c === target ? "#222" : "#eee"
                }}
              >
                <Text style={{ color: c === target ? "#fff" : "#222" }}>{c}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* Chart area */}
      <View style={{ gap: 6 }}>
        <Text style={{ fontWeight: "600" }}>3) Plot (all series, color-coded):</Text>
        {Platform.OS === "web" ? (
          <canvas ref={canvasRef} style={{ width: "100%", maxWidth: 960, height: 360, borderWidth: 1, borderColor: "#ddd" }} />
        ) : (
          <Text>Chart rendering is available on web. (This screen uses an HTML5 canvas on web.)</Text>
        )}
      </View>

      {/* Train & Predict */}
      <View style={{ gap: 10, flexDirection: "row", flexWrap: "wrap" }}>
        <Pressable
          onPress={onTrain}
          style={{ backgroundColor: "#047857", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 }}
        >
          <Text style={{ color: "#fff", fontWeight: "600" }}>Train</Text>
        </Pressable>
        <Pressable
          onPress={onPredict}
          style={{ backgroundColor: "#1d4ed8", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 }}
        >
          <Text style={{ color: "#fff", fontWeight: "600" }}>Predict (t+1)</Text>
        </Pressable>
      </View>

      {/* Status */}
      <View style={{ paddingVertical: 8 }}>
        <Text style={{ fontFamily: "monospace" }}>{status}</Text>
      </View>

      {/* Tiny help */}
      <View style={{ paddingVertical: 8 }}>
        <Text style={{ fontSize: 12, color: "#555" }}>
          a compact CART regressor is used. The supervised dataset uses all numeric
          columns at time t and their lag-1 values to predict the target at time t (used for t→t+1 prediction).
        </Text>
      </View>
    </View>
  );
}