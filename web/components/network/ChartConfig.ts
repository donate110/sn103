"use client";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

export const CHART_COLORS = {
  green: "rgb(34, 197, 94)",
  greenBg: "rgba(34, 197, 94, 0.1)",
  blue: "rgb(59, 130, 246)",
  blueBg: "rgba(59, 130, 246, 0.1)",
  amber: "rgb(245, 158, 11)",
  amberBg: "rgba(245, 158, 11, 0.1)",
  red: "rgb(239, 68, 68)",
  redBg: "rgba(239, 68, 68, 0.1)",
  slate: "rgb(100, 116, 139)",
  slateBg: "rgba(100, 116, 139, 0.1)",
  purple: "rgb(168, 85, 247)",
  purpleBg: "rgba(168, 85, 247, 0.1)",
};

/** Distinct colors for IP /24 cluster groups. */
export const IP_CLUSTER_COLORS = [
  "#e41a1c", // red
  "#377eb8", // blue
  "#4daf4a", // green
  "#984ea3", // purple
  "#ff7f00", // orange
  "#a65628", // brown
  "#f781bf", // pink
  "#66c2a5", // teal
  "#fc8d62", // salmon
  "#8da0cb", // periwinkle
  "#e78ac3", // rose
  "#a6d854", // lime
  "#ffd92f", // gold
  "#e5c494", // tan
  "#b3b3b3", // grey
];

export const UNIQUE_IP_COLOR = "#475569"; // slate-600
export const GHOST_IP_COLOR = "#cbd5e1"; // slate-300

export const baseLineOpts: ChartOptions<"line"> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: {
      position: "top",
      labels: { usePointStyle: true, boxWidth: 6, font: { size: 11 } },
    },
  },
  scales: {
    x: {
      ticks: { maxRotation: 0, maxTicksLimit: 12, font: { size: 10 } },
      grid: { display: false },
    },
    y: {
      beginAtZero: true,
      ticks: { font: { size: 10 } },
      grid: { color: "rgba(0,0,0,0.04)" },
    },
  },
};

export const baseBarOpts: ChartOptions<"bar"> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: {
      display: false,
    },
  },
  scales: {
    x: {
      ticks: { maxRotation: 90, maxTicksLimit: 40, font: { size: 9 } },
      grid: { display: false },
    },
    y: {
      beginAtZero: true,
      ticks: { font: { size: 10 } },
      grid: { color: "rgba(0,0,0,0.04)" },
    },
  },
};
