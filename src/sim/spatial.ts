/** Fixed-size spatial hash (chained buckets, rebuilt every tick, zero allocation after construction). */
export const HASH_SIZE = 1024;

export class SpatialHash {
  readonly head = new Int32Array(HASH_SIZE);
  readonly next: Int32Array;
  readonly inv: number;
  constructor(capacity: number, readonly cell: number) {
    this.next = new Int32Array(capacity);
    this.inv = 1 / cell;
    this.head.fill(-1);
  }
  clear(): void { this.head.fill(-1); }
  /** Longest bucket chain, walking at most `cap`+1 links per bucket so a cyclic chain is detected instead of hanging. */
  maxChain(cap: number): number {
    let worst = 0;
    for (let b = 0; b < this.head.length; b++) {
      let n = 0;
      for (let j = this.head[b]; j >= 0 && n <= cap; j = this.next[j]) n++;
      if (n > worst) worst = n;
    }
    return worst;
  }
  static key(cx: number, cy: number): number { return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & (HASH_SIZE - 1); }
  insert(i: number, x: number, y: number): void {
    const k = SpatialHash.key(Math.floor(x * this.inv), Math.floor(y * this.inv));
    this.next[i] = this.head[k];
    this.head[k] = i;
  }
}
