/** Mid of Kuru's best bid and ask; Kuru quotes prices as 1e18 fixed-point strings. Display only. */
export function kuruMid(bid: string, ask: string): number {
  return Number(BigInt(bid) + BigInt(ask)) / 2 / 1e18;
}
