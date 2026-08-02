import { Bar, Line, Pie, Doughnut, Radar } from "react-chartjs-2";
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

export default function ChartBlock({ chart }) {
  const Component = CHART_COMPONENTS[chart.type];
  if (!Component) return null;

  const data = { labels: chart.labels, datasets: chart.datasets };

  return (
    <div className="chart-block">
      {chart.title && <div className="chart-title">{chart.title}</div>}
      <Component data={data} options={{ responsive: true, color: "#edeae4" }} />
    </div>
  );
}
