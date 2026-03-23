"use client";

import { Line } from "react-chartjs-2";
import { CHART_COLORS, baseLineOpts } from "./ChartConfig";
import type { ChartOptions } from "chart.js";

interface HistoryPoint {
  t: number;
  weight: number;
  accuracy?: number;
  speed?: number;
  uptime?: number;
  sports_score?: number;
  attestation_score?: number;
}

interface TimeseriesChartProps {
  history: HistoryPoint[];
  metric: string;
}

const METRIC_CONFIG: Record<string, { label: string; color: string; colorBg: string }> = {
  weight: { label: "Weight", color: CHART_COLORS.blue, colorBg: CHART_COLORS.blueBg },
  sports_score: { label: "Sports Score", color: CHART_COLORS.green, colorBg: CHART_COLORS.greenBg },
  attestation_score: { label: "Attestation Score", color: CHART_COLORS.purple, colorBg: CHART_COLORS.purpleBg },
  accuracy: { label: "Accuracy", color: CHART_COLORS.amber, colorBg: CHART_COLORS.amberBg },
  uptime: { label: "Uptime", color: CHART_COLORS.slate, colorBg: CHART_COLORS.slateBg },
  speed: { label: "Speed", color: CHART_COLORS.red, colorBg: CHART_COLORS.redBg },
};

export default function TimeseriesChart({ history, metric }: TimeseriesChartProps) {
  const config = METRIC_CONFIG[metric] ?? METRIC_CONFIG.weight;

  const labels = history.map((h) => {
    const d = new Date(h.t * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  });

  const values = history.map((h) => {
    const val = (h as unknown as Record<string, number | undefined>)[metric];
    return val ?? 0;
  });

  const data = {
    labels,
    datasets: [
      {
        label: config.label,
        data: values,
        borderColor: config.color,
        backgroundColor: config.colorBg,
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
      },
    ],
  };

  const opts: ChartOptions<"line"> = {
    ...baseLineOpts,
    plugins: {
      ...baseLineOpts.plugins,
      tooltip: {
        backgroundColor: "rgb(15, 23, 42)",
        titleFont: { size: 12 },
        bodyFont: { size: 11 },
        padding: 10,
        cornerRadius: 8,
        callbacks: {
          title: (items) => {
            const idx = items[0].dataIndex;
            return new Date(history[idx].t * 1000).toLocaleString();
          },
          label: (item) => `${config.label}: ${Number(item.raw).toFixed(4)}`,
        },
      },
    },
  };

  return (
    <div className="h-64">
      <Line data={data} options={opts} />
    </div>
  );
}
