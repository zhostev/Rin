export function LineChart({
  points,
  height = 160,
}: {
  points: { label: string; value: number }[];
  height?: number;
}) {
  if (points.length === 0) {
    return <div className="h-40" />;
  }

  const width = 600;
  const padding = 8;
  const max = Math.max(...points.map((point) => point.value), 1);
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const coords = points.map((point, i) => {
    const x = padding + i * step;
    const y = height - padding - (point.value / max) * (height - padding * 2);
    return `${x},${y}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      preserveAspectRatio="none"
    >
      <polyline
        points={coords.join(" ")}
        fill="none"
        strokeWidth="2"
        className="stroke-sky-500 dark:stroke-sky-400"
      />
    </svg>
  );
}

export function BarList({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(...items.map((item) => item.value), 1);

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label} className="space-y-1">
          <div className="flex justify-between text-sm text-neutral-600 dark:text-neutral-300">
            <span className="truncate">{item.label}</span>
            <span className="tabular-nums">{item.value}</span>
          </div>
          <div className="h-1.5 rounded bg-neutral-200 dark:bg-neutral-700">
            <div
              className="h-1.5 rounded bg-sky-500 dark:bg-sky-400"
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
