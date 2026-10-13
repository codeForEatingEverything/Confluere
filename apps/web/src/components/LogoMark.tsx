// Generated from Confluere_Logo.jpeg: the 27x24 pixel mark, traced cell by cell into SVG runs.
const RUNS: [number, number, number][] = [[11,0,6],[8,1,12],[7,2,15],[6,3,5],[17,3,6],[5,4,4],[19,4,5],[4,5,4],[20,5,4],[21,6,4],[22,7,3],[22,8,4],[4,9,6],[23,9,3],[2,10,10],[20,10,1],[23,10,4],[0,11,6],[8,11,7],[19,11,2],[23,11,4],[0,12,4],[11,12,10],[23,12,4],[0,13,3],[13,13,7],[23,13,4],[15,14,3],[23,14,3],[22,15,4],[22,16,3],[5,17,2],[21,17,4],[4,18,4],[20,18,4],[4,19,5],[19,19,4],[5,20,6],[17,20,5],[6,21,15],[8,22,11],[10,23,7]];

/** The Confluere pixel mark. Colour follows `currentColor`, so it follows the theme. */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={(size * 24) / 27} viewBox="0 0 27 24" shapeRendering="crispEdges" className={className} aria-label="Confluere" role="img">
      {RUNS.map(([x, y, w]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={1} fill="currentColor" />
      ))}
    </svg>
  );
}
