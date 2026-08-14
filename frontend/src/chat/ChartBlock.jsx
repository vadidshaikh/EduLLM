import { Bar, Line, Pie, Doughnut, Radar } from "react-chartjs-2";
import { useTheme } from "../ThemeContext";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  ArcElement,
  RadialLinearScale,
  Tooltip,
  Legend,
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  ArcElement,
  RadialLinearScale,
  Tooltip,
  Legend
);

const CHART_COMPONENTS = { bar: Bar, line: Line, pie: Pie, doughnut: Doughnut, radar: Radar };

// Fixed-order categorical palette, stepped for each surface. Order matters
// (it's the CVD-safety mechanism) — never reorder or cycle in a way that
// reassigns a slot's hue to a different series.
const CATEGORICAL = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const SURFACE = { light: "#fcfcfb", dark: "#1a1a19" };

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Pie/doughnut slices are categories, so each data point gets its own
// palette slot. Other chart types treat each dataset as one series: a
// single series stays in slot 1 (the sequential default), multiple series
// take consecutive categorical slots.
function colorDatasets(chart, theme) {
  const palette = CATEGORICAL[theme] ?? CATEGORICAL.light;
  const surface = SURFACE[theme] ?? SURFACE.light;
  const isSliced = chart.type === "pie" || chart.type === "doughnut";

  return chart.datasets.map((dataset, i) => {
    if (isSliced) {
      const sliceColors = dataset.data.map((_, j) => palette[j % palette.length]);
      return { ...dataset, backgroundColor: sliceColors, borderColor: surface, borderWidth: 2 };
    }

    const color = palette[i % palette.length];
    if (chart.type === "line" || chart.type === "radar") {
      return {
        ...dataset,
        borderColor: color,
        backgroundColor: withAlpha(color, 0.15),
        pointBackgroundColor: color,
        pointBorderColor: color,
        borderWidth: 2,
      };
    }
    return { ...dataset, backgroundColor: withAlpha(color, 0.85), borderColor: color, borderWidth: 1 };
  });
}

/**
 * Shows a bar, line, pie, doughnut or radar chart based on the chart data provided, matching the current light/dark theme.
 */
export default function ChartBlock({ chart }) {
  const { theme } = useTheme();
  const Component = CHART_COMPONENTS[chart.type];
  if (!Component) return null;

  const data = { labels: chart.labels, datasets: colorDatasets(chart, theme) };
  const textColor = theme === "light" ? "#211f1c" : "#edeae4";
  const showLegend = data.datasets.length > 1 || chart.type === "pie" || chart.type === "doughnut";

  return (
    <div className="chart-block">
      {chart.title && <div className="chart-title">{chart.title}</div>}
      <Component
        data={data}
        options={{ responsive: true, color: textColor, plugins: { legend: { display: showLegend } } }}
      />
    </div>
  );
}
