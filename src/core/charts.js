const CHART_TYPES = new Set(['bar', 'line', 'donut']);

const asString = (value, fallback = '') => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value).trim();
};

const asNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const clampArray = (value, maxItems) => (Array.isArray(value) ? value.slice(0, maxItems) : []);

export const normalizeAssistantChart = (chart = {}) => {
  const type = CHART_TYPES.has(chart.type) ? chart.type : 'bar';
  const title = asString(chart.title).slice(0, 140);
  const labels = clampArray(chart.labels, 12)
    .map((label) => asString(label).slice(0, 80))
    .filter(Boolean);

  const datasets = clampArray(chart.datasets, 4)
    .map((dataset) => {
      const data = clampArray(dataset?.data, labels.length).map(asNumber);
      if (data.length !== labels.length || data.some((point) => point === null)) {
        return null;
      }

      return {
        label: asString(dataset.label, 'Value').slice(0, 80),
        data,
      };
    })
    .filter(Boolean);

  if (!title || labels.length === 0 || datasets.length === 0) {
    return null;
  }

  return {
    type,
    title,
    description: asString(chart.description).slice(0, 220),
    unit: asString(chart.unit).slice(0, 24),
    labels,
    datasets,
  };
};

export const validateAssistantCharts = (charts = []) => {
  if (!Array.isArray(charts)) {
    return [];
  }

  return charts
    .slice(0, 2)
    .map((chart) => normalizeAssistantChart(chart))
    .filter(Boolean);
};
