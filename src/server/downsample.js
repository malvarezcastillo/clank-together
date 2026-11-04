// Largest-Triangle-Three-Buckets: reduces a time series to `threshold` points while keeping its
// visual shape (peaks, dips and the first and last points). `points` are [x, y] sorted by x.

export function lttb(points, threshold) {
  const n = points.length;
  if (threshold >= n || threshold < 3) return points.slice();
  const out = [points[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // Average of the next bucket: the third corner of the triangle.
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += points[j][0];
      avgY += points[j][1];
    }
    const count = Math.max(nextEnd - nextStart, 1);
    avgX /= count;
    avgY /= count;
    // The point of this bucket that spans the largest triangle with the last kept point and that average.
    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    const [ax, ay] = points[a];
    let best = start;
    let bestArea = -1;
    for (let j = start; j < end; j++) {
      const area = Math.abs((ax - avgX) * (points[j][1] - ay) - (ax - points[j][0]) * (avgY - ay));
      if (area > bestArea) {
        bestArea = area;
        best = j;
      }
    }
    out.push(points[best]);
    a = best;
  }
  out.push(points[n - 1]);
  return out;
}
