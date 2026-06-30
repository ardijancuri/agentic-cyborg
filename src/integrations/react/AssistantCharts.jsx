import React from 'react';

const chartColors = ['#2563eb', '#059669', '#d97706', '#7c3aed'];

const formatValue = (value, unit) => {
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value) || 0);
  return unit ? `${formatted} ${unit}` : formatted;
};

const maxChartValue = (chart) => {
  const values = (chart.datasets || []).flatMap((dataset) => dataset.data || []);
  return Math.max(...values.map((value) => Math.abs(Number(value) || 0)), 1);
};

function BarChart({ chart }) {
  const maxValue = maxChartValue(chart);

  return (
    <div className="psa-chart-bars">
      {chart.labels.map((label, labelIndex) => (
        <div className="psa-chart-row" key={label}>
          <div className="psa-chart-label">{label}</div>
          <div className="psa-chart-row-bars">
            {chart.datasets.map((dataset, datasetIndex) => {
              const value = Number(dataset.data[labelIndex]) || 0;
              const width = Math.max(4, Math.min(100, (Math.abs(value) / maxValue) * 100));
              return (
                <div className="psa-chart-bar-line" key={dataset.label}>
                  <span
                    className="psa-chart-bar"
                    style={{ width: `${width}%`, backgroundColor: chartColors[datasetIndex % chartColors.length] }}
                  />
                  <span className="psa-chart-value">{formatValue(value, chart.unit)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function LineChart({ chart }) {
  const maxValue = maxChartValue(chart);
  const width = 320;
  const height = 132;
  const padding = 18;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;

  return (
    <div className="psa-chart-line-wrap">
      <svg className="psa-chart-line" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chart.title}>
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="psa-chart-axis" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} className="psa-chart-axis" />
        {chart.datasets.map((dataset, datasetIndex) => {
          const points = dataset.data.map((value, index) => {
            const x = padding + (chart.labels.length === 1 ? plotWidth / 2 : (plotWidth * index) / (chart.labels.length - 1));
            const y = height - padding - ((Number(value) || 0) / maxValue) * plotHeight;
            return `${x},${y}`;
          }).join(' ');

          return (
            <polyline
              key={dataset.label}
              points={points}
              fill="none"
              stroke={chartColors[datasetIndex % chartColors.length]}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </svg>
      <div className="psa-chart-x-labels">
        {chart.labels.slice(0, 6).map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}

function DonutChart({ chart }) {
  const values = chart.datasets[0]?.data || [];
  const total = values.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0) || 1;

  return (
    <div className="psa-chart-donut">
      <div className="psa-chart-segments">
        {values.map((value, index) => (
          <span
            key={`${chart.labels[index]}-${index}`}
            style={{
              width: `${(Math.max(0, Number(value) || 0) / total) * 100}%`,
              backgroundColor: chartColors[index % chartColors.length],
            }}
          />
        ))}
      </div>
      <div className="psa-chart-legend">
        {chart.labels.map((label, index) => (
          <div className="psa-chart-legend-row" key={label}>
            <span style={{ backgroundColor: chartColors[index % chartColors.length] }} />
            <span>{label}</span>
            <strong>{formatValue(values[index], chart.unit)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartCard({ chart }) {
  return (
    <figure className="psa-chart-card">
      <figcaption>
        <strong>{chart.title}</strong>
        {chart.description && <span>{chart.description}</span>}
      </figcaption>
      {chart.type === 'line' ? <LineChart chart={chart} /> : null}
      {chart.type === 'donut' ? <DonutChart chart={chart} /> : null}
      {chart.type !== 'line' && chart.type !== 'donut' ? <BarChart chart={chart} /> : null}
    </figure>
  );
}

export default function AssistantCharts({ charts = [] }) {
  if (!Array.isArray(charts) || charts.length === 0) {
    return null;
  }

  return (
    <div className="psa-charts">
      {charts.map((chart, index) => (
        <ChartCard key={`${chart.title}-${index}`} chart={chart} />
      ))}
    </div>
  );
}
